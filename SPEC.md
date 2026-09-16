# Funnel Runtime — Implementation Spec

This document is the authoritative specification for the build. Follow it. Where it
conflicts with your instincts, follow the spec — several decisions here look
arbitrary but exist to close specific correctness holes that are documented inline.

**Deliverable:** a single repository containing a configurable multi-step funnel
runtime with versioning, rollback, server-assigned A/B, an idempotent event pipeline,
and an analytics dashboard. Deployed to a public URL.

---

## 0. Non-negotiable principles

Read these before writing any code. Every one of them is load-bearing.

1. **One implementation of funnel logic.** Condition evaluation, visible-step
   computation, navigation, progress and result resolution live in `src/shared/`
   and are imported by both the server and the React app. Never duplicate this
   logic. Never let the two sides diverge.
2. **Config is an opaque blob.** Funnel configs are stored as a single JSON text
   column. Event-specific properties are stored as a single JSON text column.
   Adding a step, a branch, or an event type in a new config version must require
   **zero** DDL and **zero** changes to validation, ingest, storage or analytics
   code. The one honest exception: a *new user interaction* needs a trigger point in
   the renderer. Build those trigger points gated on the pinned config's
   `events.allowed` list (§6), so they ship once and stay dormant for versions that
   do not allow the event.
3. **Analytics counts distinct sessions over set membership — never event
   sequences.** This single rule is what makes duplicate events, repeat views,
   back-navigation and out-of-order arrival irrelevant by construction.
4. **The funnel is a graph, not a list.** The config has a conditional step.
   Index-based funnel math will produce wrong numbers. Use traversed edges. See §7.
5. **The server is the source of truth** for session state, current step, pinned
   version, assigned variant and computed result. The client never decides these;
   it renders what the server returns.
6. **Raw answers never enter the analytics store.** They live on the session row
   only. The `events` table is physically incapable of holding them.

---

## 1. Stack and repository layout

- Node 22, TypeScript, ESM.
- **Fastify** for HTTP. `@fastify/static` serves the built React app from the same
  process and the same port.
- **better-sqlite3** — synchronous, no async ceremony in handlers. WAL mode.
- **Vite + React 18 + TypeScript** for the frontend. React Router for three routes.
- **Zod** for all schema validation: funnel config, event payloads, admin inputs.
- **Vitest** for unit and integration tests.
- **tsx** to run the server — no server build step.

**Single `package.json`. No npm workspaces.** Workspaces buy enforced module
boundaries we do not need and cost hours of ESM/CJS resolution pain between Vite and
Node. Use a path alias instead.

```
/configs
  funnel-v1.json          # provided; boot-seeded (§9)
  /iteration-2
    funnel-v3.json        # provided; published through the admin API only, never boot-seeded
/src
  /shared                 # isomorphic core — no DOM, no I/O, no imports from server or web
    config.schema.ts      # Zod schema for the funnel config
    conditions.ts         # condition DSL evaluator
    navigation.ts         # visible steps, next/prev, progress
    results.ts            # result rule resolution
    variant.ts            # variant materialisation (overrides merge)
    api.ts                # Zod request/response schemas for every route — the contract parallel tracks build against
    types.ts
  /server
    index.ts              # fastify bootstrap, static serving, boot seed
    db.ts                 # better-sqlite3 connection, schema bootstrap
    schema.sql
    queries.ts            # raw SQL
    /routes
      session.ts
      events.ts
      admin.ts
      analytics.ts
  /web
    main.tsx
    /funnel               # the funnel renderer
    /internal             # the internal console at /dashboard: Overview,
                          # Experiment, Versions (analytics + admin), Events
    /lib
      eventQueue.ts
/scripts
  seed.ts                 # synthetic traffic generator
/tests
/data                     # gitignored; funnel.db lives here locally
```

Alias `@shared/*` → `src/shared/*` in **both** `tsconfig.json` (`paths`) and
`vite.config.ts` (`resolve.alias`). `src/shared` has no build step — Vite bundles it
for the browser, `tsx` runs it on the server.

Dev: `npm run dev` runs `tsx watch src/server/index.ts` and `vite` concurrently, with
Vite proxying `/api` to the server port.

---

## 2. Database

Four tables. `schema.sql` executed on boot with `CREATE TABLE IF NOT EXISTS`. No
migration tooling.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS funnel_versions (
  funnel_id       TEXT NOT NULL,
  version         INTEGER NOT NULL,
  config_json     TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (funnel_id, version)
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  funnel_id         TEXT NOT NULL,
  funnel_version    INTEGER NOT NULL,
  experiment_id     TEXT,
  variant           TEXT NOT NULL,
  variant_forced    INTEGER NOT NULL DEFAULT 0,
  utm_source        TEXT,
  utm_medium        TEXT,
  utm_campaign      TEXT,
  answers_json      TEXT NOT NULL DEFAULT '{}',
  current_step_id   TEXT,
  result_id         TEXT,
  is_synthetic      INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  FOREIGN KEY (funnel_id, funnel_version) REFERENCES funnel_versions(funnel_id, version)
);

CREATE TABLE IF NOT EXISTS events (
  event_id        TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  name            TEXT NOT NULL,
  step_id         TEXT,
  client_ts       TEXT,
  server_ts       TEXT NOT NULL,
  funnel_id       TEXT NOT NULL,
  funnel_version  INTEGER NOT NULL,
  experiment_id   TEXT,
  variant         TEXT NOT NULL,
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  props_json      TEXT NOT NULL DEFAULT '{}',
  is_synthetic    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events_rejected (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT,
  raw_json     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session_name ON events(session_id, name);
CREATE INDEX IF NOT EXISTS idx_events_name_step    ON events(name, step_id);
CREATE INDEX IF NOT EXISTS idx_events_version      ON events(funnel_version, variant);
```

Note the privacy boundary: raw answers exist only in `sessions.answers_json`.
Analytics queries read `events` and `sessions` and therefore cannot see them.
Analytics SQL must never select `answers_json`; `queries.ts` should make that
obvious by listing session columns explicitly rather than `SELECT *`.

The foreign keys are real guarantees, not decoration: an event for a session that
does not exist, or a session pinned to a version that does not exist, fails at the
database even if a handler check is missed. Old versions and sessions are never
deleted, so the FKs never block a legitimate write.

---

## 3. `src/shared` — the core

### 3.1 Config schema (`config.schema.ts`)

A Zod schema that accepts both `configs/funnel-v1.json` and
`configs/iteration-2/funnel-v3.json`. It must validate on publish and reject anything
it cannot execute.

**Whitelist step types and operators explicitly.** Publishing a config that
references a step type or condition operator this build does not implement must fail
at publish time with a clear error — not render a blank screen to a user later.

- Step types: `info`, `single-select`, `multi-select`, `number`, `result`.
- Operators: `eq`, `neq`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `contains`.
  (`contains` is required by v3: `priorities contains "compliance"`.)
- Condition groups: `all`, `any`, `not`.

**Referential integrity** — collect *every* violation, do not stop at the first:

- every ID in every variant's `stepSequence` exists in `steps`;
- every `steps[id].id` equals its key;
- every sequence has exactly one `result` step, and it is last;
- every condition leaf's `answer` — in `visibleWhen` **and** in `resultRules[].when`
  — references a real, answer-bearing step (not `info` or `result`);
- **ordering:** in every variant's sequence, a step's `visibleWhen` may only
  reference steps that appear *earlier* in that same sequence. Otherwise the gate can
  never resolve before the step is reached;
- every key in `stepOverrides` exists in `steps`; every key in `resultOverrides`
  exists in `results`;
- every `resultId` in `resultRules` exists in `results`; `defaultResultId` exists;
- variant weights are non-negative integers summing to 100;
- `events.allowed` names are unique.

**Informational fields.** `status`, `releaseNote`, `description`, `locale` and each
event's `trigger` are accepted and ignored by the runtime. In particular `status`
(v3 ships as `"draft"`) has no effect: activation is governed solely by
`funnel_versions.is_active` (§5). The submitted JSON is stored **verbatim** in
`config_json`, not the Zod-parsed (key-stripped) object.

### 3.2 Condition evaluator (`conditions.ts`)

```ts
evaluate(node: ConditionNode, answers: Answers): boolean
```

Recursive over `all` / `any` / `not`; leaves are `{ answer, operator, value }`.
A leaf whose referenced answer is **missing** evaluates to `false`, never throws —
this holds for negative operators too (`neq`, `nin`): "not answered" is not "answered
with something else". Use `not` explicitly if absence should match.
Unknown operator throws — but publish-time validation should have caught it.

| Operator | Answer type | True when |
|---|---|---|
| `eq` / `neq` | scalar | strict equality / inequality |
| `in` / `nin` | scalar | answer is / is not an element of `value` (an array) |
| `gt` `gte` `lt` `lte` | number | numeric comparison; non-number answer → `false` |
| `contains` | array (multi-select) | answer array includes `value` (a scalar); non-array answer → `false` |

A type mismatch returns `false`, never throws.

### 3.3 Variant materialisation (`variant.ts`)

```ts
materialise(config: FunnelConfig, variant: 'A' | 'B'): MaterialisedConfig
```

Returns a config where `stepSequence` is the variant's sequence, `stepOverrides` are
deep-merged into `steps`, and `resultOverrides` are deep-merged into `results`.

**The renderer must never know a variant exists.** It receives a materialised config
and renders it. This is what makes iteration 2's "remove a step for variant B" a
pure config change.

### 3.4 Navigation and progress (`navigation.ts`)

```ts
visibleSteps(config: MaterialisedConfig, answers: Answers): StepId[]
nextStep(config, answers, from: StepId): StepId | null
prevStep(config, answers, from: StepId): StepId | null
validate(step: Step, value: unknown): { ok: true } | { ok: false; message: string }
progress(config, answers, currentStepId): { current: number; total: number }
```

`visibleSteps` walks `stepSequence`, including a step when it has no `visibleWhen` or
when `evaluate(visibleWhen, answers)` is true. Steps with `type` in
`progress.excludeTypes` (`info`, `result`) are excluded from progress counting but
are still navigable steps.

**Progress policy — implement exactly this and document it in the README.**
A conditional step whose gating answer is *not yet given* **counts toward the total**.
Once the gating answer resolves, the step is included or excluded for real. This
guarantees the denominator only ever shrinks, never grows. Users tolerate "fewer
questions than expected"; a progress bar that jumps backwards reads as a bug.

**Orphaned answers.** If a user goes back and changes an answer such that a
previously-answered step becomes hidden, **keep the stored answer** but exclude it
from `visibleSteps`, from progress, and from result evaluation. Re-entering the
branch then feels like the form remembered. Do not delete it.

### 3.5 Result resolution (`results.ts`)

```ts
resolveResult(config: MaterialisedConfig, answers: Answers): string
```

Evaluate `resultRules` in array order, first match wins, fall back to
`defaultResultId`. Only answers for currently-visible steps are passed in.

---

## 4. Session lifecycle

### `POST /api/session` — create or resume

Reads an httpOnly cookie `fsid` holding the session's random UUID (`maxAge` =
`ttlHours`). No signing — a random UUID is already unguessable. If a valid session
exists, resume it.
Otherwise create one:

1. Read the **active** version — this is the only place in the entire codebase that
   reads `is_active`. After creation, config is always resolved by
   `sessions.funnel_version`.
2. Assign variant: `hash(session_id + experiment_id) % 100`, bucketed by the
   `weights` in `config.experiment.variants`. Use a stable hash (FNV-1a or SHA-256
   truncated). Persist the result on the session row — stickiness is then a property
   of the data, not of the hash.
3. Capture `utm_source`, `utm_medium`, `utm_campaign` from the query string.
   **First-touch only** — never overwrite on later requests, or a session could land
   in two campaign buckets.
4. Emit `session_started` **server-side**, so it can never be lost by a client.

Response:

```ts
{
  sessionId, funnelVersion, variant, variantForced,
  config,              // materialised for this session's variant
  answers, currentStepId, visibleSteps, progress, resultId
}
```

### Query parameter handling

- `?variant=A|B` — applies **only at session creation**. Sets `variant_forced = 1`.
  If an override arrives for an *existing* session with a *different* variant,
  **start a new session** rather than mutating the pinned one. Mutating would break
  both the stickiness invariant and the integrity of the analytics.
- `?reset=1` — clears the cookie and starts a fresh session. Also expose a small
  "Start over" control on the funnel UI. **This is required** — without it a
  reviewer cannot exercise both variants or both branches without opening devtools.

### Navigation: `POST /api/session/answer` and `POST /api/session/back`

**The server decides navigation; the client renders what it returns.** No optimistic
advance, no client/server reconciliation. Same-origin round-trips are tens of
milliseconds; the client disables the button while a request is in flight.

- `POST /api/session/answer` — body `{ stepId, value? }`. `value` is omitted for
  `info` steps. The server validates with `shared/navigation.validate`, persists into
  `answers_json`, sets `current_step_id = nextStep(...)` and, if that is the result
  step, resolves the result (below).
- `POST /api/session/back` — body `{ stepId }`. Sets
  `current_step_id = prevStep(...)`. Because Back is persisted, a refresh after Back
  resumes where the user actually is.

Both return `{ currentStepId, visibleSteps, progress, resultId }`. If `stepId` is not
the session's `current_step_id` (double-click, stale tab), change nothing and return
the current state — the client simply re-renders it.

The client still imports `shared/navigation.validate` to show validation messages
instantly before posting; the server re-validates. One implementation, two callers.

### Result computation

When navigation reaches the `result` step, the **server** calls `resolveResult`,
writes `result_id` onto the session row, and returns it. The server then stamps
`result_id` onto `result_viewed` and `cta_clicked` events from that row. The client
never derives the result — otherwise the two events can disagree and the dashboard
cannot segment by result.

### TTL

`session.ttlHours` (72), read from the session's **pinned** config. On resume, if
`created_at` is older than the TTL, treat the
session as absent and create a new one — which means a new version and possibly a new
variant. Document this in the README.

---

## 5. Versioning and rollback

All admin routes require `Authorization: Bearer ${ADMIN_TOKEN}` from an env var.

- `GET  /api/admin/versions` → list with `is_active`, `created_at`, live session count
  per version.
- `POST /api/admin/versions` → body is a raw funnel config. Validate with the Zod
  schema. Reject with `400` and a readable error listing every problem. Store under
  the config's own `(funnelId, version)`. **Does not activate.**

  **Version numbering rule: the config's `version` field is authoritative.** It must
  be a positive integer strictly greater than every existing version for that
  `funnelId`; otherwise reject with `409`. Gaps are allowed — publishing
  `funnel-v3.json` onto a database holding only v1 stores **v3**, not v2. This keeps
  the number in the file, the admin table, the event rows and the dashboard
  identical. (Server-assigned `max + 1` was rejected: it would silently store the
  provided v3 file as "version 2" while its JSON says 3.)
- `POST /api/admin/versions/:version/activate` → in a transaction, set `is_active = 0`
  for all rows of that `funnel_id`, then `is_active = 1` for the target. Publish and
  rollback are the *same operation* — rollback is just activating a lower number.
- `GET  /api/admin/versions/:version` → raw config JSON for inspection.

**Version management** lives on the **Versions** tab of the internal console: version
table with active badge, activate/rollback buttons, a raw JSON viewer, a drop-zone /
paste box to publish a new version, and a single-field form for the admin token
persisted to `sessionStorage`. The tab's upper half is the public version analytics
and renders without a token; only the management half below the divider is gated, so
the first config can still be published on an empty database. `/admin` redirects here.

Old versions are never deleted, so sessions pinned to them keep resolving forever.

---

## 6. Event pipeline

### `POST /api/events`

Body is **always** a batch: `{ events: [...] }`. A single event is a batch of one.

Per-item processing:

1. Zod-validate shape. On failure → `events_rejected` with a reason, continue.
2. Look up the session. Unknown session → reject, continue.
3. Validate `name` against the **pinned version's** `config.events.allowed` list.
   This is what lets iteration 2 introduce a new event name with zero ingest-code
   change, and what stops an old v1 session from firing the v3-only
   `recommendation_expanded`.
   **Server-only events:** `session_started` is in `allowed` but may only be written
   by the server. A client-submitted `session_started` is rejected with reason
   `server_only_event` — otherwise a client could inflate the Started denominator.
4. Server **re-derives and overwrites** `funnel_id`, `funnel_version`,
   `experiment_id`, `variant`, `utm_*` and `is_synthetic` from the session row.
   Never trust the client for these. The client can lie; the session cannot.
5. Server stamps `server_ts`. `client_ts` is stored as-is and used for nothing
   except display.
6. Insert.

### Idempotency — get this exactly right

```sql
INSERT INTO events (...) VALUES (...) ON CONFLICT(event_id) DO NOTHING;
```

Then check `changes()` to distinguish `accepted` from `duplicate`.

**Do not use `INSERT OR IGNORE`.** It suppresses *every* constraint violation, not
just the primary key, so a NOT NULL or CHECK failure would be silently swallowed and
reported to the client as a successful duplicate. That is the exact opposite of the
guarantee this endpoint is supposed to provide. (Foreign-key failures are not covered
by `OR IGNORE` and would still throw — so it is not even consistently silent.)

### Response

Always `200`, with a per-item outcome array:

```ts
{ results: [ { event_id, status: 'accepted' | 'duplicate' | 'rejected', reason? } ] }
```

A malformed item never fails the batch. A retry after timeout is safe. Both
properties must be covered by tests.

### Client queue (`src/web/lib/eventQueue.ts`)

An array, a 2-second flush interval, and a `sendBeacon` flush on `visibilitychange`.
Mirror the pending queue to `localStorage` so a refresh mid-flight does not lose
events. `event_id` is a UUID generated **once at enqueue time** and reused across
every retry — that is what makes server-side dedup work. Retry with backoff; drop
after ~5 attempts. Roughly 60 lines; do not reach for a library.

Emit, per `funnel-v1.json`: `step_viewed`, `answer_submitted`, `step_completed`,
`back_clicked`, `result_viewed`, `cta_clicked`. `session_started` is server-side.

Navigation events are emitted **after** the server's navigation response, using its
values: `answer_submitted` (non-info steps) and `step_completed` with
`next_step_id = response.currentStepId` after `/answer`; `back_clicked` with
`destination_step_id = response.currentStepId` after `/back`; then `step_viewed` for
the step now rendered. Events therefore always describe the path the server
recorded.

**`step_completed` fires on every forward navigation from any non-result step,
including `info` steps** (props: `next_step_id`). The config's trigger text says
"from a valid interactive step"; we deliberately widen it. Without the
`intro → first question` edge, the first interactive step has no incoming edge and
its Eligible count (§7) is zero. Document this deviation in the README.

**Allowed-list gating on the client.** The event queue drops, before enqueueing, any
event whose name is not in the materialised config's `events.allowed`. Renderer
trigger points are written once and are inert for versions that do not allow them.

**`recommendation_expanded`** (allowed from v3). The result screen's CTA with
`action: "expand_recommendation"` expands the result's `recommendations` list.
On click the client emits `cta_clicked`, then `recommendation_expanded` with
`{ action, source: "cta" }`. The allowed-list gate makes it a no-op for v1 sessions.
Build this trigger point in iteration 1 — the expand behaviour already exists in v1.
The server stamps `result_id` onto `result_viewed`, `cta_clicked` **and**
`recommendation_expanded` from the session row. Generalise: any event whose allowed
`properties` include `result_id` gets it from the session row, never from the client.

`answer_submitted` carries `answer_kind` only (`"single-select"`, `"number"`, …) —
**never the answer value**. That is the privacy rule, and it is enforced by the
`events.allowed[].properties` whitelist: strip any property not on the list for that
event name.

---

## 7. Analytics — the part most likely to be wrong

### The core rule

Every metric is `COUNT(DISTINCT session_id)` over a **set-membership** predicate.
Never over an ordered sequence, never over event counts. Duplicates, repeat views,
back-navigation and out-of-order arrival then cannot affect any number.

### Funnel math must be edge-based, not index-based

The config contains `office_days`, which is only visible when
`work_mode ∈ {hybrid, office}`. A fully-remote session never sees it.

If you compute "conversion into step *i*" as `reached(i) / reached(i-1)` using the
`stepSequence` index, remote sessions land in the denominator of a step they were
never eligible for, and `office_days` will show catastrophic fake drop-off. Fixing it
by filtering on the `work_mode` answer is impossible — that answer is deliberately not
in the analytics store.

The config already solves this: `step_completed` carries `next_step_id`. That is a
traversed graph edge, not an answer. Use it.

```
Reached(S)   = COUNT(DISTINCT session_id)
               WHERE name = 'step_viewed' AND step_id = S

Eligible(S)  = COUNT(DISTINCT session_id)
               WHERE name = 'step_completed'
                 AND json_extract(props_json, '$.next_step_id') = S

Converted(S) = sessions in BOTH Reached(S) AND Eligible(S)

Conversion into S = Converted(S) / Eligible(S)
```

Remote sessions are now simply absent from `office_days`'s denominator. Correct, with
no answer data.

**Numerator is the intersection, not raw Reached.** A session can have a
`step_viewed` for S without a matching edge — a `step_completed` the client queue
dropped after its retries, or a browser closed before the queue flushed.
`Reached / Eligible` would then exceed 100%. `Converted / Eligible` is bounded by
construction. Show raw Reached alongside; `Reached − Converted` is a data-quality
signal, not a conversion.

**Entry step** (first in `stepSequence`) has no incoming edge — its Eligible set is
the `session_started` set. Every other step, including the first interactive one,
uses edges; this depends on info steps emitting `step_completed` (§6).

```
DropOff(S) = sessions in Reached(S) that have NO step_completed with step_id = S
             AND no result_viewed
```

"Later step" is undefined in a branching graph. "Has an outgoing edge" is well-defined.
Use the latter.

**Drop-off is per step, not a partition of abandoned sessions.** A session can be
counted at more than one step: it views `office_days`, goes back, switches to remote,
then abandons at `async_maturity` — it has no outgoing edge from either. So the sum of
per-step drop-off can exceed the number of abandoned sessions. This is intentional (it
answers "of those who saw this step, how many never moved past it?") and must be
stated in the README and as a footnote under the dashboard table.

**Unknown / new event names.** Alongside the fixed metrics, show a generic table of
`COUNT(DISTINCT session_id)` per event name for the current filter. This is how
`recommendation_expanded` appears on the dashboard in iteration 2 with zero analytics
code change.

### Required metrics

- **Started** — `COUNT(DISTINCT session_id) WHERE name = 'session_started'`.
- **Per-step reached / eligible / conversion / drop-off** — as above.
- **Completion** — `DISTINCT result_viewed` ÷ `DISTINCT session_started`.
- **CTA CTR** — `DISTINCT cta_clicked` ÷ `DISTINCT result_viewed`.
- **A vs B comparison.**
- **Version comparison.**
- **Filter by UTM campaign**, read from the **session** row, not from events.

### Cross-variant comparison — do not compare per-step

Variant B **reorders** the steps, and in iteration 2 **removes** one. Comparing by
position is meaningless; comparing by step ID compares different funnel positions.

- **Across variants:** compare funnel-level metrics only — end-to-end conversion,
  completion rate, CTA CTR. This is also the statistically
  honest comparison; per-step tests across reordered funnels invite fishing.
- **Within a variant:** show the per-step breakdown.
- A step absent from a variant or version renders as **`n/a`**, never `0%`.
  Same rule for version comparison.

### `GET /api/analytics`

Query params: `version`, `variant`, `utm_campaign`. Nothing else.

Compute on request in SQL. At this volume no materialisation is needed. Read
`stepSequence` from the stored config for the requested version+variant so
aggregation is config-aware.

`variant_forced` sessions are **always** excluded from the A/B comparison card —
forced assignment is not random assignment. They are included everywhere else, so a
reviewer's own `?variant=B` sessions still show up in the per-step table. No toggle.

### Internal console UI (`/dashboard`)

A persistent filter bar and KPI row (started / completed / CTA CTR / conversion) above
four tabs, so each metric family appears exactly once:

| Tab | Contents |
|---|---|
| Overview | Per-step funnel meters + the full numbers table behind a disclosure |
| Experiment | A-vs-B funnel-level bars, metric table, z-test |
| Versions | Version comparison and step×version matrix; admin controls below the gate |
| Events | Distinct sessions per event name |

Absolute session counts appear **next to every percentage**. Correct numbers come
first, but the numbers have to be readable: the Overview bars encode each step's
*reach* as a share of the sessions that started, because the edge-based conversion
ratio is ~100% at every step and plots as a wall of full bars. Conversion stays in
the table, where it works as the data-quality check it is.

Chart colours are a validated two-slot categorical palette (variant A / variant B)
plus a single-hue ordinal ramp for the meters, with explicit light and dark values;
versions are a single series and never borrow the A/B pair.

---

## 8. Traffic generator (`scripts/seed.ts`)

```
npm run seed -- --sessions=150 --seed=42 --target=http://localhost:3000
```

**Drive it through the real HTTP API, not direct DB writes.** That is how it proves
idempotency, batching and validation actually work end to end. Seeded PRNG so the
dashboard numbers are reproducible.

Must produce:

- ≥100 sessions across several UTM campaigns / sources / mediums.
- Both variants (let the server assign; do not force).
- `work_mode` answers exercising **both sides** of the `office_days` branch.
- Drop-off distributed across different steps, not all at one.
- Some back-navigation with `back_clicked`.
- **Duplicate `event_id`s** within a batch.
- **One entire batch re-sent verbatim.**
- Batches with shuffled order and skewed `client_ts` (out-of-order arrival).
- A handful of schema-invalid events mixed into otherwise valid batches.
- At least one client-sent `session_started` (must be rejected `server_only_event`).
- `recommendation_expanded` on some CTA clicks. It is accepted on v3 sessions and
  rejected as not allowed on v1 sessions — both outcomes are expected.

**Versions.** The generator creates sessions on whatever version is **active** and
never touches admin routes. Multi-version data comes from the iteration flow: run it
once on v1, then again after activating v3 (§11). The generator reads the
materialised config from `POST /api/session`, so it walks any version's steps with
no code change.

Mark all of it `is_synthetic = 1`.

After the run, assert a few invariants in the script output (total sessions, total
events, rejected count) so a regression is visible without opening the dashboard.

---

## 9. Boot-time seeding

On server startup, in order:

1. Execute `schema.sql`.
2. For each `*.json` file directly in `/configs` (**not** subdirectories), if that
   `(funnel_id, version)` is not present, validate and insert it. Iteration configs
   under `/configs/iteration-2/` are published through the admin API only.
3. If no version is active, activate the lowest version.

That is all. **Synthetic traffic is never generated on boot.** On production the
data lives on the volume and is seeded once (§12). Auto-seeding an empty database on
boot would hide a wrong volume mount: a redeploy that wiped the DB would come back
looking populated, defeating deploy-checklist step 4. Locally, `npm run seed` after
`npm run dev` populates the dashboard.

---

## 10. Tests

Map these 1:1 to the brief's §7.1 and name the files so a reviewer can find them.
Keep the suite to this list; it covers the five required areas plus the two tests
that prove correctness (marked ★).

`tests/version-pinning.test.ts`
- Create session → publish v3 → activate → the session still serves v1 config and
  stamps `funnel_version: 1`. A new session created afterwards gets v3.
- ★ The v1 session continues to the result step without errors after v3 is active.

`tests/variant-stability.test.ts`
- Repeated session fetches return the same variant, including across a publish.
- Distribution over a **fixed list** of session IDs matches weights within tolerance.
  Use fixed IDs, not random ones, or the test is flaky by construction.
- `?variant=B` on an existing A session creates a new session rather than mutating.

`tests/event-dedup.test.ts`
- Same batch twice → row count unchanged, second response reports `duplicate`.
- Mixed valid/invalid batch → partial success, invalid items in `events_rejected`.
- `recommendation_expanded` from a v1 session is rejected (not in pinned `allowed`).

`tests/publish-rollback.test.ts`
- Activation pointer moves; exactly one active version at a time.
- Publishing `funnel-v3.json` onto a v1-only DB stores version 3; a config with an
  unknown operator is rejected `400` and nothing is stored.
- Rollback to v1 leaves v3 events queryable.

`tests/analytics.test.ts`
- Hand-built fixture containing duplicates, a back-click and a late-arriving event,
  asserted against hand-computed numbers.
- ★ **A remote-path session must not appear in `office_days`'s denominator.** This is
  the test that proves the edge-based funnel is correct.

`tests/shared/*.test.ts`
- Condition evaluator (including `contains`), progress policy under an unresolved
  branch, orphaned-answer handling, result resolution. Both provided configs pass the
  config schema.

Integration tests spin the real Fastify app against a temp-file SQLite DB.

---

## 11. Iteration 2

The new config is `configs/iteration-2/funnel-v3.json` (`version: 3` — there is no
v2). Compared with v1 it:

- adds `security_constraints`, visible when `priorities contains "compliance"`
  (and a `compliance` option on `priorities`) — a second conditional branch;
- adds a `meeting_hours` number step to both variants;
- removes `tool_count` from variant B;
- adds results `regulated_scale` and `meeting_heavy`, placed first in `resultRules`;
- adds the event `recommendation_expanded`;
- changes the experiment id to `question-order-and-result-framing-v3`, so v3 sessions
  hash into buckets independently of v1.

Because config is a blob and event props are JSON, the whole iteration is:
start a v1 session and leave it mid-funnel → `POST` v3 via the admin page (stored as
v3, §5) → activate → click through v3 in both variants and both new branches →
re-run the generator (it targets the now-active v3) so the dashboard shows v1 and v3
side by side → finish the old v1 session → activate v1 again. **Zero DDL.**

v3 uses the `contains` operator, which is why it is in the §3.1 whitelist from
iteration 1. If a future config uses a capability the build lacks, the whitelists
catch it at publish time with a readable error, not at runtime in a user's browser.
Additionally, the renderer should render an unknown step type as a skip-able
placeholder rather than crashing (defence in depth for configs stored before a
whitelist change).

Verify explicitly that a session created on the old version before the publish
continues to completion without errors afterwards.

---

## 12. Deployment

Single Dockerfile, single service, single port.

- `PORT` from env, bind `0.0.0.0`.
- `DB_PATH` from env; `/data/funnel.db` in production, `./data/funnel.db` locally.
- `ADMIN_TOKEN` from env.
- Fastify serves `/api/*` and `dist/` with an SPA fallback for `/dashboard` (and `/admin`,
  which the client redirects to the console's Versions tab).

**Railway** with a Volume mounted at `/data` is the target: trial credit covers the
evaluation window, no credit card, Dockerfile auto-detected, Generate Domain for a
public URL. Fly.io with `fly volumes create` is an equivalent alternative.

Do **not** target Vercel, Netlify, Cloudflare Workers or any serverless platform —
no persistent filesystem and no single long-lived process, so SQLite cannot work.
Render's **free** tier cannot attach a persistent disk; only its paid tiers can.

**Mount the volume at `/data`, never over the source directory** — mounting over
`/app` hides the code and the container will not boot.

Deploy checklist:

1. Public URL loads the funnel.
2. Run the seed script against the **public URL**, not localhost — a reviewer must
   not open an empty dashboard.
3. Publish and roll back a version through the admin page **on production**.
4. Push a trivial commit, redeploy, confirm data survived. Do this early. A wrong
   mount path looks perfect until it silently wipes everything on every push.

---

## 13. README requirements

The brief grades this. Include:

- Public URL, repository link, **admin token**, and the `?reset=1` / `?variant=B`
  query parameters so a reviewer can exercise both variants and both branches.
- Local setup: clone, `npm i`, `npm run dev`, then `npm run seed` to populate the
  dashboard.
- **Data model**, event schema, and aggregation rules — explicitly explain the
  edge-based funnel and why index-based counting would be wrong for the conditional
  step; why conversion uses the Reached ∩ Eligible intersection; that drop-off is
  per step and can count one session at several steps; and that `step_completed` also
  fires from info steps (a deliberate widening of the config's trigger text).
- Version numbering: the config's own `version` is authoritative and must increase;
  gaps are allowed (hence v1 → v3).
- **Progress policy** under an unresolved branch, and orphaned-answer behaviour.
- **A/B hypothesis and primary metric** (§14).
- Timeline of iteration 1 and iteration 2.
- **Known limitations** — see §15.
- A short "how this was built" section describing the agent workflow (§16): contracts
  first, four parallel tracks in separate worktrees, a review agent before each merge,
  and what review caught. The brief weights this at 15%.

---

## 14. A/B hypothesis (for the README)

> **Hypothesis.** Variant B front-loads the two lowest-effort, highest-relevance
> context questions (`work_mode`, `timezone_span`) before asking for team specifics,
> and reframes the result as a concrete next action ("See the 30-day action list")
> rather than a passive label. Reducing early effort and making the payoff concrete
> should increase end-to-end conversion.
>
> **Primary metric.** Unique sessions with `cta_clicked` ÷ unique sessions with
> `session_started`.
>
> **Secondary.** Completion rate (`result_viewed` / `session_started`); progression
> from the first to the second interactive step.
>
> **Guardrail.** Drop-off on `priorities` — B rewords this step and the change could
> hurt it.

A two-proportion z-test on the primary metric is ~20 lines and makes the metric
interpretation credible. If it is cut for time, say so in limitations.

---

## 15. Known limitations to state explicitly

Listing these reads as engineering judgment. Omitting them reads as oversight.

- Single SQLite writer → one instance, no horizontal scaling, brief interruption on
  redeploy.
- Multi-tab: two tabs share one cookie and one session row; `answers_json` is
  last-write-wins, so tabs at different steps can clobber each other.
- `next_step_id` in `step_completed` is a low-cardinality derived signal that reveals
  which branch a session took. This is a deliberate trade — branching analytics is
  impossible without it — and it is strictly less information than the raw answer.
- Admin auth is a shared bearer token, not real authentication.
- No visual config editor (excluded by the brief).
- Free-tier hosting: first request after idle may be slow.
- Statistical significance testing, if cut.

---

## 16. Build order

Contracts first, then parallel tracks, then integration. Parallelism is only safe
because phase 1 fixes every shared interface before anyone builds against it.

**Phase 1 — Contracts (one agent, sequential).** Scaffold, `schema.sql`, config
schema, all of `src/shared` with its unit tests, and `src/shared/api.ts` (Zod
request/response schemas for every route in §4–§7). Human review of the contracts
before phase 2 starts; changes to `src/shared` after this point go through one
owner.

**Phase 2 — Parallel tracks (one agent each, separate git worktrees).** Each track
depends only on phase 1 and ships its own tests from §10.

| Track | Work | Tests |
|---|---|---|
| A. Session & admin | `/api/session` create/resume/answer/back, variant assignment, TTL, boot config seed, admin routes + the console's Versions tab | version-pinning, variant-stability, publish-rollback |
| B. Funnel UI | Renderer, five step types + unknown-type placeholder, Back / refresh / Start over, result + CTA expand, event emission, `eventQueue.ts` | — (manual click-through) |
| C. Event ingest & generator | `/api/events`, `events_rejected`, `scripts/seed.ts` | event-dedup |
| D. Analytics | `/api/analytics` SQL + the console, built against a hand-made fixture DB so it does not wait on C | analytics |

**Phase 3 — Review and integrate.** A review agent checks each track's diff against
this spec (especially the "Never cut" list) before merge. Merge A → C → B → D, run
the generator against localhost, full test suite green.

**Phase 4 — Deploy.** Deploy, seed production, verify redeploy persistence (§12).

**Phase 5 — Iteration 2 and README** (§11, §13).

If time compresses, cut in this order: dashboard charts → tables only; significance
testing → drop; E2E tests → drop; admin version-history view → drop.

**Never cut:** edge-based analytics, `ON CONFLICT DO NOTHING`, the stated progress
policy, server-side result computation, `?reset=1`, production seeding. Those six are
small and carry disproportionate rubric weight.