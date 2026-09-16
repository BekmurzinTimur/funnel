# Funnel Runtime

A small platform for running, versioning and analysing configurable multi-step web funnels:
a JSON-config-driven renderer, immutable config versions with publish/rollback,
server-assigned A/B variants, an idempotent batched event pipeline and an edge-based
analytics dashboard. TypeScript end to end, one process, one SQLite file.

| | |
|---|---|
| Public URL | https://funnel-production-1c0d.up.railway.app/ |
| Repository | https://github.com/BekmurzinTimur/funnel |
| Internal console | https://funnel-production-1c0d.up.railway.app/dashboard — analytics, plus publishing, activating and rollback on its **Versions** tab. No sign-in: the console and the admin API are open in this review deployment (see [Known limitations](#known-limitations-and-assumptions)). `/admin` deep-links to the Versions tab. |

**Reviewer shortcuts** (append to the funnel URL):

| Query | Effect |
|---|---|
| `?reset=1` | Drop the session cookie and start a fresh session (the "Start over" link does the same). |
| `?variant=A` / `?variant=B` | Force a variant for a *new* session. On an existing session with a different variant, a new session is started — the pinned one is never mutated. Forced sessions are excluded from the A/B comparison card. |
| `?utm_campaign=…&utm_source=…&utm_medium=…` | First-touch attribution, stored on the session row. |

For example:

- Variant A from scratch: https://funnel-production-1c0d.up.railway.app/?reset=1&variant=A
- Variant B from scratch: https://funnel-production-1c0d.up.railway.app/?reset=1&variant=B
- With attribution: https://funnel-production-1c0d.up.railway.app/?reset=1&utm_source=review&utm_medium=manual&utm_campaign=review

To see both branches: answer `work_mode` = *Hybrid* or *Mostly in the office* to get the
`office_days` question, *Fully remote* to skip it. On v3 (activate it on the console's Versions tab), selecting
*Compliance and access control* in `priorities` opens `security_constraints`, and variant B no
longer asks `tool_count`.

---

## Local setup

```bash
git clone <repo> && cd funnel
npm i
npm run dev          # Fastify on :3000 (tsx watch) + Vite on :5173, /api proxied
npm run seed         # in another terminal: 150 synthetic sessions through the HTTP API
```

Open http://localhost:5173 (funnel) and `/dashboard` (the internal console); its Versions tab
publishes, activates and rolls back versions with no sign-in.

| Command | |
|---|---|
| `npm test` | Vitest: shared core + integration tests against a temp-file SQLite DB |
| `npm run build && npm start` | Production mode: one port serves `/api/*` and the built SPA |
| `npm run seed -- --sessions=150 --seed=42 --target=http://localhost:3000` | Traffic generator |
| `npm run typecheck` | `tsc --noEmit` |

Environment: `PORT` (3000) and `DB_PATH` (`./data/funnel.db`; `/data/funnel.db` in the image).

On boot the server applies `schema.sql`, inserts any `configs/*.json` (top level only) whose
`(funnelId, version)` is missing, and activates the lowest version if none is active. It
never generates traffic — an empty dashboard after a redeploy means the volume is wrong, not
that the data needs re-seeding.

---

## Architecture

```
src/shared   isomorphic core: config schema, condition evaluator, variant materialisation,
             navigation/progress, result resolution, API contracts (Zod)
src/server   Fastify + better-sqlite3: session, events, admin, analytics routes
src/web      React: funnel renderer (/), internal console (/dashboard), event queue
scripts      seed.ts traffic generator
configs      funnel-v1.json (boot-seeded), iteration-2/funnel-v3.json (published via admin)
```

Principles the code is organised around:

1. **One implementation of funnel logic.** Visibility, navigation, progress, validation and
   result resolution live in `src/shared` and are imported by both server and client.
2. **Config is an opaque blob** (`funnel_versions.config_json`), event properties are a JSON
   column. A new step, branch or event type needs zero DDL and zero changes to validation,
   ingest, storage or analytics code.
3. **The server is the source of truth** for session state, current step, pinned version,
   variant and result. The client renders what the server returns; no optimistic navigation.
4. **Analytics counts distinct sessions over set membership**, never event sequences.
5. **Raw answers never reach the analytics store.** They live only in `sessions.answers_json`.

---

## Data model

Four tables (`src/server/schema.sql`), created with `CREATE TABLE IF NOT EXISTS` — no migrations.

| Table | Purpose |
|---|---|
| `funnel_versions` | `(funnel_id, version)` PK, `config_json` stored **verbatim** as submitted, `is_active` pointer. Rows are never deleted. |
| `sessions` | Pinned `funnel_version` (FK), `experiment_id`, `variant`, `variant_forced`, first-touch `utm_*`, `answers_json`, `current_step_id`, server-computed `result_id`, `is_synthetic`, timestamps. |
| `events` | `event_id` PK (idempotency key), `session_id` (FK), `name`, `step_id`, `client_ts`, `server_ts`, attribution copied from the session row, `props_json`. **No answer column exists.** |
| `events_rejected` | Raw JSON + reason for every rejected item. |

Foreign keys are enforced (`PRAGMA foreign_keys = ON`): an event for a non-existent session or a
session pinned to a non-existent version fails at the database even if a handler check is missed.

### Sessions, pinning and TTL

- `POST /api/session` resumes the session in the httpOnly `fsid` cookie, or creates one.
  Creation is the **only** place the active version is read; afterwards config is always
  resolved from `sessions.funnel_version`, so publishing never affects a running session.
- Variant = `FNV-1a(session_id + experiment_id) % 100` bucketed by the config's weights, then
  **persisted** — stickiness is a property of the row, not of the hash. v3 changes the
  experiment id, so v3 sessions bucket independently of v1.
- `session_started` is written server-side in the same transaction as the session row.
- Navigation is server-side: `POST /api/session/answer` validates with the shared validator,
  stores the answer, computes the next visible step and — on reaching the result step —
  resolves and stores `result_id`. `POST /api/session/back` persists the previous visible step,
  so refresh after Back resumes where the user actually is. A stale `stepId` (double click,
  second tab) changes nothing and returns the current state.
- **TTL:** `session.ttlHours` (72) of the *pinned* config. A session older than that is treated
  as absent: the next visit creates a new session on the **currently active** version, which
  may also mean a different variant.

### Versioning and rollback

- `POST /api/admin/versions` validates the config (every problem listed, 400) and stores it
  under the config's own `(funnelId, version)`. It does **not** activate.
- **Version numbering:** the `version` field in the file is authoritative and must be strictly
  greater than every stored version of that funnel (otherwise 409). Gaps are allowed — the
  provided v3 file is stored as version 3 on a database that only has v1, so the number in the
  file, the admin table, event rows and the dashboard always agree.
- `POST /api/admin/versions/:v/activate` moves the pointer in one transaction. Publish and
  rollback are the same operation; rollback is activating a lower number.
- Whitelists: step types `info | single-select | multi-select | number | result`, operators
  `eq neq in nin gt gte lt lte contains`, groups `all any not`. A config using anything else is
  rejected at publish time. Referential checks include: every sequence ID exists, one result
  step and it is last, condition answers reference answer-bearing steps, and **a step's
  `visibleWhen` may only reference steps earlier in the same variant's sequence**. As defence
  in depth the renderer shows an unknown step type as a skippable placeholder.
- `status`, `releaseNote`, `description`, `locale` and event `trigger` texts are informational;
  `status: "draft"` in v3 has no effect — only `is_active` governs activation.

---

## Funnel behaviour

### Progress policy

Progress counts only steps the user can reach, excluding `info` and `result` types.
**A conditional step whose gating answer has not been given yet counts toward the total.**
Once the gate resolves, the step is included or excluded for real. On a forward path the
denominator therefore only shrinks ("7 questions" → "6 questions" after choosing *Fully
remote*); it never jumps up, which would read as a bug. Changing an earlier answer on the way
back can of course re-open a branch.

### Orphaned answers

If the user goes back and changes an answer so that a previously answered step becomes hidden,
the stored answer is **kept** but excluded from visible steps, progress and result evaluation
(the evaluator only sees answers of currently visible steps, transitively). Re-entering the
branch pre-fills the old answer.

### Result

Rules are evaluated in array order on the server; first match wins, otherwise
`defaultResultId`. The client never derives the result, and the server stamps `result_id` from
the session row onto `result_viewed`, `cta_clicked` and `recommendation_expanded`, so events and
the dashboard can never disagree about which result a session saw.

---

## Event schema

`POST /api/events` always takes a batch: `{ "events": [ ... ] }`.

```jsonc
{
  "event_id": "5b0c…",           // UUID generated once at enqueue time, reused on every retry
  "session_id": "…",
  "name": "step_completed",
  "step_id": "timezone_span",
  "client_ts": "2026-09-15T10:00:00.000Z",
  "props": { "next_step_id": "async_maturity" }
}
```

Stored rows add `server_ts` and `funnel_id`, `funnel_version`, `experiment_id`, `variant`,
`utm_source`, `utm_medium`, `utm_campaign`, `is_synthetic` — **re-derived from the session row**;
anything the client sends for those is ignored.

| Event | Emitted | Properties |
|---|---|---|
| `session_started` | server, on session creation (client-sent → rejected `server_only_event`) | — |
| `step_viewed` | a step is rendered | `step_type`, `visible_step_index`, `visible_step_count` |
| `answer_submitted` | after a successful `/answer` on a question step | `answer_kind` (the step type — **never the value**) |
| `step_completed` | after every forward navigation from any non-result step, **including info steps** | `next_step_id` (from the server response) |
| `back_clicked` | after `/back` | `destination_step_id` (from the server response) |
| `result_viewed` | result rendered | `result_id` (server-stamped) |
| `cta_clicked` | result CTA clicked | `result_id` (server-stamped), `action` |
| `recommendation_expanded` | v3+: CTA expanded the recommendations | `result_id` (server-stamped), `action`, `source` |

**Deliberate deviation:** the config's trigger text says `step_completed` fires "from a valid
interactive step". We also fire it from info steps. Without the `intro → first question` edge,
the first interactive step would have no incoming edge and an Eligible count of zero.

Navigation events are emitted *after* the server's response using its values, so events always
describe the path the server recorded. The response carries the `sessionId` the cookie resolved to;
if it is not the tab's own session, or the step differs from what the shared `nextStep`/`prevStep`
predict (another tab moved the session), the tab reloads the session and emits nothing.

### Ingest rules (per item; a bad item never fails the batch)

1. Zod shape check → `invalid_shape`.
2. Session lookup → `unknown_session`.
3. Name must be in the **pinned** version's `events.allowed` → `event_not_allowed`
   (this is what lets v3 add `recommendation_expanded` with no ingest change, and what rejects it
   from v1 sessions). `session_started` from a client → `server_only_event`.
4. Properties not whitelisted for that event name are stripped, and a whitelisted property is kept
   only if its value is a scalar (string ≤ 200 chars, number, boolean or null) — the privacy boundary:
   an answer object cannot be smuggled in under an allowed key.
5. Attribution fields re-derived from the session, `server_ts` stamped.
6. `INSERT … ON CONFLICT(event_id) DO NOTHING`, then `changes` → `accepted` or `duplicate`.
   (`INSERT OR IGNORE` is avoided on purpose: it would also swallow NOT NULL/CHECK violations and
   report them as successful duplicates.)

Response is always `200 { results: [{ event_id, status: accepted|duplicate|rejected, reason? }] }`,
so retrying after a timeout is safe.

**Client queue** (`src/web/lib/eventQueue.ts`): in-memory array mirrored to `localStorage`,
flushed every 2 s, `sendBeacon` on `visibilitychange`, exponential backoff, dropped after 5
attempts. Events whose name is not in the session config's `allowed` list are dropped before
enqueueing, so renderer trigger points ship once and stay dormant for versions that don't allow them.

---

## Aggregation rules

Every metric is `COUNT(DISTINCT session_id)` over a **set-membership** predicate. Duplicate
events, repeated views, back-navigation and out-of-order arrival cannot change any number.
Filters (`version`, `variant`, `utm_campaign`) are applied to the **session** row.

| Metric | Definition |
|---|---|
| Started | sessions with `session_started` |
| Completion | sessions with `result_viewed` ÷ Started |
| CTA CTR | sessions with `cta_clicked` ÷ sessions with `result_viewed` |
| Reached(S) | sessions with `step_viewed` for S |
| Eligible(S) | sessions with `step_completed` whose `next_step_id = S` (entry step: the Started set) |
| Converted(S) | sessions in **Reached(S) ∩ Eligible(S)** |
| Conversion into S | Converted(S) ÷ Eligible(S) |
| Drop-off(S) | sessions in Reached(S) with no `step_completed` from S and no `result_viewed` |

### Why the funnel is edge-based, not index-based

`office_days` is only shown when `work_mode ∈ {hybrid, office}`. Computing "conversion into step
*i*" as `reached(i) / reached(i−1)` by `stepSequence` index puts every fully-remote session into
the denominator of a step it could never see, so `office_days` would show a large fake
drop-off. Filtering by the `work_mode` answer is impossible by design — answers are not in the
analytics store. `step_completed.next_step_id` is a traversed graph edge, not an answer: a remote
session's edge from `timezone_span` points to `async_maturity`, so it is simply absent from
`office_days`'s Eligible set. (Tested in `tests/analytics.test.ts`.)

### Why the numerator is the intersection

A session can have a `step_viewed` for S without the matching incoming edge — e.g. a
`step_completed` the client queue dropped after its retries, or a tab closed before the flush.
`Reached ÷ Eligible` could then exceed 100 %; `(Reached ∩ Eligible) ÷ Eligible` is bounded by
construction. Raw Reached is shown alongside; `Reached − Converted` is a data-quality signal.

**Reading the per-step table.** Navigation is server-driven, so a recorded edge into S is almost
always followed by a `step_viewed` for S: *Conversion into S* is normally close to 100 %, and a
lower value means views were lost (e.g. the tab closed between the server response and the render).
Where users abandon is the **Drop-off** column — sessions that saw a step and never left it.

### Drop-off is per step

"Later step" is undefined in a branching graph; "has an outgoing edge" is well defined. A session
can be counted at more than one step — it views `office_days`, goes back, switches to remote and
abandons at `async_maturity` — so per-step drop-off can sum to more than the number of abandoned
sessions. That is intended: it answers "of those who saw this step, how many never moved past it?"

### Comparing variants and versions

Variant B reorders steps (and in v3 removes `tool_count`), so per-step comparison across
variants compares different funnel positions. **Across variants only funnel-level metrics are
compared** (end-to-end conversion, completion, CTA CTR); per-step tables are shown within a
variant. A step absent from a variant or version renders as **n/a**, never 0 %. Sessions with
a forced variant (`?variant=`) are always excluded from the A/B card — forced assignment is not
random assignment — and included everywhere else.

---

## A/B experiment

> **Hypothesis.** Variant B front-loads the two lowest-effort, highest-relevance context questions
> (`work_mode`, `timezone_span`) before asking for team specifics, and reframes the result as a
> concrete next action ("See the 30-day action list") rather than a passive label. Reducing early
> effort and making the payoff concrete should increase end-to-end conversion.
>
> **Primary metric.** Unique sessions with `cta_clicked` ÷ unique sessions with `session_started`.
>
> **Secondary.** Completion rate (`result_viewed` ÷ `session_started`); progression from the first
> to the second interactive step.
>
> **Guardrail.** Drop-off on `priorities` — B rewords this step and the change could hurt it.

The dashboard's A/B card runs a pooled two-proportion z-test on the primary metric.

---

## Iteration 2

`configs/iteration-2/funnel-v3.json` (`version: 3`; there is no v2) adds a second conditional
branch (`security_constraints` when `priorities contains "compliance"`), a `meeting_hours` step,
removes `tool_count` from variant B, adds two results placed first in `resultRules`, adds the
`recommendation_expanded` event and changes the experiment id.

It shipped with **zero DDL and zero changes** to validation, ingest, storage or analytics:
publish on the Versions tab → stored as v3 → activate → new sessions run v3 while existing v1 sessions
finish on v1 → roll back by activating v1. The `contains` operator and the
`recommendation_expanded` trigger point were built in iteration 1 (the latter dormant behind the
allowed-list gate).

**Verified locally** (scripted HTTP + headless Chrome against the production build):

1. A v1 session answered three steps and was left at `priorities`.
2. `funnel-v3.json` published through the admin API → stored as **version 3**, inactive, text
   byte-identical to the file; then activated.
3. v3 variant A: *Compliance* opened `security_constraints` → `regulated_scale`. v3 variant B
   (remote, 20 meeting hours): `meeting_hours` asked, no `tool_count`, `security_constraints` or
   `office_days` → `meeting_heavy` with B's title override. CTA expanded the recommendations and
   `recommendation_expanded` was accepted for v3 sessions.
4. The traffic generator re-run on the now-active v3; all invariants passed.
5. The old session resumed on **v1** at `priorities` and finished with a v1 result;
   a `recommendation_expanded` sent for it was rejected `event_not_allowed`.
6. Rolled back by activating v1: new sessions get v1, v3 events and analytics stay queryable, and
   the dashboard compares v1 and v3 (`tool_count` shows *n/a* for v3 variant B).
7. `sqlite_master` was identical before and after the whole flow — zero DDL.

---

## Timeline

| When | Phase |
|---|---|
| Day 1, 23:23 | Brief, spec and configs committed. |
| 23:23 – 23:33 | **Iteration 1, phase 1 — contracts:** scaffold, `schema.sql`, all of `src/shared` with unit tests, `api.ts` route contracts, server seam (`buildApp`, queries, boot seed). |
| 23:35 – 00:12 | **Phase 2 — four parallel tracks** in separate git worktrees (session & admin, funnel UI, event ingest & generator, analytics). In parallel on `main`: Dockerfile/Railway config and the README draft. |
| 00:12 – 00:26 | **Phase 3 — review & integrate:** one review agent per track, merge A → C → B → D, end-to-end generator run, headless-browser click-through of both variants and branches, review fixes. |
| Day 2, ~00:30 | **Iteration 2:** v3 published, activated, clicked through, generator re-run, old v1 session finished, rolled back — no schema or pipeline changes. |
| Day 2 | **Deploy:** Railway, single Docker service with a volume at `/data`; public domain generated. |

---

## Deployment (Railway)

The production instance runs on Railway from this repository.

1. **New Project → Deploy from GitHub repo.** Railway builds the `Dockerfile`; `railway.json` pins
   the Dockerfile builder, one replica, restart on failure and the `/api/health` healthcheck.
2. **Variables:** `PORT=3000`. `NODE_ENV=production` and `DB_PATH=/data/funnel.db` are set in the
   image.
3. **Attach a volume mounted at `/data`** — never at `/app`, which would hide the code.
4. **Settings → Networking → Public Networking → Generate Domain**, target port `3000`. Use that
   `*.up.railway.app` URL; the `http://10.x.x.x:3000` address in the deploy log is Railway's private
   network and is not reachable from a browser.
5. Every push to `main` redeploys. Data lives on the volume, so it survives redeploys; the server
   never generates traffic on boot, so an empty dashboard after a deploy means the volume is wrong.

Fly.io with `fly volumes create` mounted at `/data` is equivalent. Serverless platforms
(Vercel, Netlify, Workers) cannot work: no persistent filesystem or long-lived process for SQLite.
Render works only on a paid instance with a persistent disk at `/data`.

### Reproducing the dashboard data

The generator drives the public HTTP API only, so it works against any deployment:

```bash
# v1 active
npm run seed -- --sessions=150 --seed=42 --target=https://funnel-production-1c0d.up.railway.app
# after publishing and activating configs/iteration-2/funnel-v3.json on the Versions tab
npm run seed -- --sessions=120 --seed=7 --target=https://funnel-production-1c0d.up.railway.app
```

Different seeds give v1 and v3 independent simulated audiences. The same seed reproduces the same
per-step decisions; exact numbers still vary slightly because the server assigns variants from
random session IDs. All generated sessions and events are marked `is_synthetic = 1`.

---

## Known limitations and assumptions

- **Single SQLite writer** → one instance, no horizontal scaling, brief interruption on redeploy.
- **Multi-tab:** two tabs share one cookie and one session row; `answers_json` is last-write-wins,
  so tabs at different steps can clobber each other. Stale `stepId`s are ignored, and a tab whose
  navigation response does not match its own session and predicted step reloads instead of emitting
  events, which limits the damage to analytics.
- **Event queue across tabs:** the pending queue is mirrored to one `localStorage` key, so two tabs
  can overwrite each other's copy; a tab that crashes before flushing can lose its unsent events.
- **`next_step_id` reveals the branch taken.** It is a low-cardinality derived signal and strictly
  less information than the raw answer; branching analytics is impossible without it.
- **The admin API has no authentication.** `/api/admin/*` and the console's Versions tab are open to
  anyone who can reach the deployment, so any visitor could publish a config, activate a version or
  roll one back. This is a deliberate trade for a review deployment, where reviewers need to exercise
  publish and rollback without a credential; the data at risk is fictional. A real deployment needs
  authentication in front of those routes — the shared bearer token this build used earlier is the
  minimum, and SSO or an admin network the honest answer.
- **No visual config editor** (out of scope per the brief).
- **Free-tier hosting:** the first request after idle may be slow.
- **Result id on late events:** `result_id` is stamped at ingest time from the session row; if a user
  goes back from the result and reaches a different result before a delayed event arrives, that event
  carries the newer result.
- **Seed reproducibility:** the generator's choices are seeded, but session IDs (and therefore
  variant assignment) are generated by the server, so per-variant splits vary slightly between runs.
- **One funnel per deployment:** publishing a config with a different `funnelId` is rejected (409),
  and the dashboard and admin page assume a single funnel. The schema itself supports more.

---

## How this was built

Built with Claude Code as an orchestrator of sub-agents, following the build order in
[SPEC.md §16](SPEC.md). Parallelism was only safe because the interfaces were fixed first.

**1. Contracts first (one agent, sequential).** The orchestrating session wrote everything the
tracks would build against: the config schema and whitelists, the condition evaluator, variant
materialisation and assignment, navigation/progress/results, `src/shared/api.ts` (Zod
request/response schemas for every route), `schema.sql`, and a server seam (`buildApp()` for
`app.inject` tests, explicit-column queries including the idempotent event insert, boot seed,
route stubs, router shell). Unit tests for the shared core were green before any track started.

**2. Four parallel tracks, each in its own git worktree.** Each agent got its spec sections, the
decisions already made, a strict file-ownership list and its tests from §10. `src/shared` was
frozen — contract changes had to be requested, not made (none were requested; one was later made
by the orchestrator, below). Tracks without a live dependency built against the contracts: the
analytics track used a hand-made fixture DB, the ingest track inserted session rows directly, the
UI track built against `api.ts` types.

| Track | Delivered | Tests |
|---|---|---|
| A. Session & admin | session lifecycle, variant assignment, TTL, admin routes, version management UI | version-pinning, variant-stability, publish-rollback |
| B. Funnel UI | renderer, 5 step types + unknown placeholder, Back/refresh/Start over, events, `eventQueue.ts` | manual (scripted browser run at integration) |
| C. Ingest & generator | `/api/events`, `events_rejected`, `scripts/seed.ts` | event-dedup |
| D. Analytics | `/api/analytics` SQL, the analytics console | analytics |

**3. A review agent per track before merge.** Each reviewer read the track's diff against the spec
(especially the "never cut" list), ran the tests and probed edge cases with scratch scripts. What
review caught and what changed as a result:

- **Funnel UI (blocker):** after another tab replaced the session cookie (Start over or
  `?variant=B`), a stale tab treated the other session's state as its own navigation — emitting a
  fake `priorities → intro` edge under the wrong session and polluting per-step analytics. Fixed with
  a contract change (`sessionId` on navigation responses) plus a check against shared
  `nextStep`/`prevStep` before emitting.
- **Funnel UI:** the event queue silently dropped batches on any 4xx (e.g. 429 or a proxy 404
  mid-deploy); `result_viewed` could fire from the result *error* screen and inflate completion.
- **Ingest:** a database fault on one item was reported as the client's `invalid_shape` (so the
  client dropped it), and could leave a partially committed batch; allowed property *keys* could
  still carry answer objects as *values*, breaking the privacy boundary; the generator's invariants
  were lower bounds that a server mislabelling outcomes would still pass.
- **Admin:** publishing a config with a typo in `funnelId` stored it as a second funnel that boot
  seeding would activate on the next restart; `resultId` leaked into non-result steps after Back.
- **Analytics:** a key built with NUL separators made `analytics.ts` a binary file to git, hiding
  the core module from diffs; the dashboard version selector showed a stale value mid-request.
- Reviews also independently re-derived the hand-computed analytics numbers and confirmed the ★
  remote-session test fails under index-based math.

**4. Integration checks run by the orchestrator** (not just the unit suite): a trial merge of all
four branches; the generator against a real production build (every invariant, 0 server errors);
a scripted headless-Chrome click-through of both variants, both branches, validation, Back, refresh,
Start over and the CTA, followed by reading the events table to confirm the recorded edges; the
iteration-2 flow above with a schema diff; and a 200 000-UUID check that variant assignment is
unbiased after one generator run showed a lopsided 45/75 split (it was chance).

**Process issues worth noting.** All four worktrees were created from the initial commit rather than
the contracts commit; each agent detected it and fast-forwarded before starting, and one agent's
first `npm ci` escaped into the main checkout before it noticed (harmless, same lockfile — verified).
