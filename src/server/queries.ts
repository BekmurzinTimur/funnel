// Raw SQL. Columns are always listed explicitly. `sessions.answers_json` is
// selected only by the session lifecycle queries below — analytics must never
// read it.
import type { Statement } from 'better-sqlite3';
import type { FunnelConfig } from '@shared/types';
import type { DB } from './db';

export const nowIso = (): string => new Date().toISOString();

const statements = new WeakMap<DB, Map<string, Statement>>();
export function stmt(db: DB, sql: string): Statement {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  let prepared = cache.get(sql);
  if (!prepared) cache.set(sql, (prepared = db.prepare(sql)));
  return prepared;
}

// ---------------------------------------------------------------------------
// funnel_versions
// ---------------------------------------------------------------------------

export interface VersionRow {
  funnel_id: string;
  version: number;
  config_json: string;
  schema_version: string;
  is_active: number;
  created_at: string;
}

const VERSION_COLUMNS = 'funnel_id, version, config_json, schema_version, is_active, created_at';

export function getVersion(db: DB, funnelId: string, version: number): VersionRow | undefined {
  return stmt(db, `SELECT ${VERSION_COLUMNS} FROM funnel_versions WHERE funnel_id = ? AND version = ?`).get(
    funnelId,
    version,
  ) as VersionRow | undefined;
}

/**
 * The active version. Serving code calls this only when creating a session;
 * everything after creation resolves config through sessions.funnel_version.
 */
export function getActiveVersion(db: DB): VersionRow | undefined {
  return stmt(db, `SELECT ${VERSION_COLUMNS} FROM funnel_versions WHERE is_active = 1 ORDER BY funnel_id LIMIT 1`).get() as
    | VersionRow
    | undefined;
}

export function listVersions(db: DB): VersionRow[] {
  return stmt(db, `SELECT ${VERSION_COLUMNS} FROM funnel_versions ORDER BY funnel_id, version`).all() as VersionRow[];
}

export function maxVersion(db: DB, funnelId: string): number | null {
  const row = stmt(db, 'SELECT MAX(version) AS max FROM funnel_versions WHERE funnel_id = ?').get(funnelId) as {
    max: number | null;
  };
  return row.max;
}

/** Inserts a version, never active. Publishing does not activate. */
export function insertVersion(db: DB, row: Omit<VersionRow, 'is_active'>): void {
  stmt(
    db,
    `INSERT INTO funnel_versions (funnel_id, version, config_json, schema_version, is_active, created_at)
     VALUES (@funnel_id, @version, @config_json, @schema_version, 0, @created_at)`,
  ).run(row);
}

/** Publish and rollback are the same operation. Returns false if the version does not exist. */
export function activateVersion(db: DB, funnelId: string, version: number): boolean {
  return db.transaction(() => {
    if (!getVersion(db, funnelId, version)) return false;
    stmt(db, 'UPDATE funnel_versions SET is_active = 0 WHERE funnel_id = ?').run(funnelId);
    stmt(db, 'UPDATE funnel_versions SET is_active = 1 WHERE funnel_id = ? AND version = ?').run(funnelId, version);
    return true;
  })();
}

/** Boot rule §9.3: for each funnel with no active version, activate the lowest. */
export function ensureActiveVersion(db: DB): void {
  const funnels = stmt(
    db,
    `SELECT funnel_id, MIN(version) AS lowest, MAX(is_active) AS any_active
     FROM funnel_versions GROUP BY funnel_id`,
  ).all() as { funnel_id: string; lowest: number; any_active: number }[];
  for (const f of funnels) if (!f.any_active) activateVersion(db, f.funnel_id, f.lowest);
}

/** Funnel IDs that hold a given version number (normally one). */
export function funnelsWithVersion(db: DB, version: number): string[] {
  return (
    stmt(db, 'SELECT funnel_id FROM funnel_versions WHERE version = ? ORDER BY funnel_id').all(version) as {
      funnel_id: string;
    }[]
  ).map((r) => r.funnel_id);
}

const configs = new WeakMap<DB, Map<string, FunnelConfig>>();

/**
 * Parsed config for a stored version. Stored rows are immutable, so they are
 * cached. Not re-validated: a config stored before a whitelist change must still
 * load (the renderer degrades unknown step types gracefully).
 */
export function loadConfig(db: DB, funnelId: string, version: number): FunnelConfig | undefined {
  let cache = configs.get(db);
  if (!cache) configs.set(db, (cache = new Map()));
  const key = `${funnelId}@${version}`;
  let config = cache.get(key);
  if (!config) {
    const row = getVersion(db, funnelId, version);
    if (!row) return undefined;
    config = JSON.parse(row.config_json) as FunnelConfig;
    cache.set(key, config);
  }
  return config;
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  funnel_id: string;
  funnel_version: number;
  experiment_id: string | null;
  variant: string;
  variant_forced: number;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  answers_json: string;
  current_step_id: string | null;
  result_id: string | null;
  is_synthetic: number;
  created_at: string;
  last_seen_at: string;
}

const SESSION_COLUMNS = `id, funnel_id, funnel_version, experiment_id, variant, variant_forced,
  utm_source, utm_medium, utm_campaign, answers_json, current_step_id, result_id,
  is_synthetic, created_at, last_seen_at`;

export function getSession(db: DB, id: string): SessionRow | undefined {
  return stmt(db, `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
}

export function insertSession(db: DB, row: SessionRow): void {
  stmt(
    db,
    `INSERT INTO sessions (${SESSION_COLUMNS}) VALUES (
      @id, @funnel_id, @funnel_version, @experiment_id, @variant, @variant_forced,
      @utm_source, @utm_medium, @utm_campaign, @answers_json, @current_step_id, @result_id,
      @is_synthetic, @created_at, @last_seen_at)`,
  ).run(row);
}

export function updateSessionState(
  db: DB,
  id: string,
  state: { answers_json: string; current_step_id: string | null; result_id: string | null },
): void {
  stmt(
    db,
    `UPDATE sessions SET answers_json = @answers_json, current_step_id = @current_step_id,
       result_id = @result_id, last_seen_at = @last_seen_at WHERE id = @id`,
  ).run({ ...state, id, last_seen_at: nowIso() });
}

export function touchSession(db: DB, id: string): void {
  stmt(db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), id);
}

/**
 * Sessions pinned to a version: total, and live (created strictly after `liveSince`,
 * an ISO timestamp — created_at is always written by nowIso, so string order is time order).
 */
export function countVersionSessions(
  db: DB,
  funnelId: string,
  version: number,
  liveSince: string,
): { total: number; live: number } {
  return stmt(
    db,
    `SELECT COUNT(id) AS total, COALESCE(SUM(created_at > ?), 0) AS live
     FROM sessions WHERE funnel_id = ? AND funnel_version = ?`,
  ).get(liveSince, funnelId, version) as { total: number; live: number };
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export interface EventRow {
  event_id: string;
  session_id: string;
  name: string;
  step_id: string | null;
  client_ts: string | null;
  server_ts: string;
  funnel_id: string;
  funnel_version: number;
  experiment_id: string | null;
  variant: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  props_json: string;
  is_synthetic: number;
}

/** Builds an event row whose attribution fields come from the session row, never the client. */
export function eventFromSession(
  session: SessionRow,
  event: { event_id: string; name: string; step_id?: string | null; client_ts?: string | null; props?: Record<string, unknown> },
): EventRow {
  return {
    event_id: event.event_id,
    session_id: session.id,
    name: event.name,
    step_id: event.step_id ?? null,
    client_ts: event.client_ts ?? null,
    server_ts: nowIso(),
    funnel_id: session.funnel_id,
    funnel_version: session.funnel_version,
    experiment_id: session.experiment_id,
    variant: session.variant,
    utm_source: session.utm_source,
    utm_medium: session.utm_medium,
    utm_campaign: session.utm_campaign,
    props_json: JSON.stringify(event.props ?? {}),
    is_synthetic: session.is_synthetic,
  };
}

/**
 * Idempotent insert. ON CONFLICT(event_id) DO NOTHING — not INSERT OR IGNORE,
 * which would also swallow NOT NULL/CHECK violations and report them as
 * duplicates. `changes` distinguishes accepted from duplicate.
 */
export function insertEvent(db: DB, row: EventRow): 'accepted' | 'duplicate' {
  const info = stmt(
    db,
    `INSERT INTO events (event_id, session_id, name, step_id, client_ts, server_ts, funnel_id,
       funnel_version, experiment_id, variant, utm_source, utm_medium, utm_campaign, props_json, is_synthetic)
     VALUES (@event_id, @session_id, @name, @step_id, @client_ts, @server_ts, @funnel_id,
       @funnel_version, @experiment_id, @variant, @utm_source, @utm_medium, @utm_campaign, @props_json, @is_synthetic)
     ON CONFLICT(event_id) DO NOTHING`,
  ).run(row);
  return info.changes === 1 ? 'accepted' : 'duplicate';
}

export function insertRejected(db: DB, row: { session_id: string | null; raw_json: string; reason: string }): void {
  stmt(
    db,
    'INSERT INTO events_rejected (session_id, raw_json, reason, received_at) VALUES (@session_id, @raw_json, @reason, @received_at)',
  ).run({ ...row, received_at: nowIso() });
}

// ---------------------------------------------------------------------------
// analytics — reads `events` and non-answer `sessions` columns only.
// ---------------------------------------------------------------------------
//
// Every metric is COUNT(DISTINCT session_id) over a set-membership predicate
// (SPEC §7). Session filters are applied on the sessions row (never on the
// event copies of utm/variant), and `answers_json` is never referenced.

/** Filters on the sessions row. `null` means "not filtered". */
export interface AnalyticsFilter {
  funnelId: string;
  version: number | null;
  variant: string | null;
  campaign: string | null;
  /** 1 = drop variant_forced sessions (A/B comparison only). */
  excludeForced: 0 | 1;
}

const SESSION_FILTER = `s.funnel_id = @funnelId
  AND (@version IS NULL OR s.funnel_version = @version)
  AND (@variant IS NULL OR s.variant = @variant)
  AND (@campaign IS NULL OR s.utm_campaign = @campaign)
  AND (@excludeForced = 0 OR s.variant_forced = 0)`;

export interface FunnelCountsRow {
  version: number | null;
  variant: string | null;
  started: number;
  completed: number;
  ctaClicked: number;
}

const FUNNEL_GROUPINGS = {
  none: { select: 'NULL AS version, NULL AS variant', groupBy: '' },
  version: { select: 's.funnel_version AS version, NULL AS variant', groupBy: 'GROUP BY s.funnel_version' },
  variant: { select: 'NULL AS version, s.variant AS variant', groupBy: 'GROUP BY s.variant' },
  versionVariant: {
    select: 's.funnel_version AS version, s.variant AS variant',
    groupBy: 'GROUP BY s.funnel_version, s.variant',
  },
} as const;
export type FunnelGrouping = keyof typeof FUNNEL_GROUPINGS;

/** Started / completed / CTA-clicked distinct sessions, optionally grouped. */
export function analyticsFunnelCounts(db: DB, filter: AnalyticsFilter, grouping: FunnelGrouping): FunnelCountsRow[] {
  const g = FUNNEL_GROUPINGS[grouping];
  return stmt(
    db,
    `SELECT ${g.select},
       COUNT(DISTINCT CASE WHEN e.name = 'session_started' THEN e.session_id END) AS started,
       COUNT(DISTINCT CASE WHEN e.name = 'result_viewed'   THEN e.session_id END) AS completed,
       COUNT(DISTINCT CASE WHEN e.name = 'cta_clicked'     THEN e.session_id END) AS ctaClicked
     FROM sessions s
     JOIN events e ON e.session_id = s.id
     WHERE ${SESSION_FILTER}
     ${g.groupBy}`,
  ).all(filter) as FunnelCountsRow[];
}

export interface StepReachRow {
  version: number;
  variant: string;
  stepId: string;
  /** Reached(S): distinct sessions with step_viewed for S. */
  reached: number;
  /** Reached(S) ∩ sessions with an incoming edge step_completed.next_step_id = S. */
  edgeConverted: number;
  /** Reached(S) ∩ session_started — the Converted set when S is the entry step. */
  entryConverted: number;
  /** Reached(S) with no step_completed whose step_id = S and no result_viewed. */
  dropOff: number;
}

/** Reach-side per-step sets, grouped by (version, variant, step). */
export function analyticsStepReach(db: DB, filter: AnalyticsFilter): StepReachRow[] {
  return stmt(
    db,
    `SELECT s.funnel_version AS version, s.variant AS variant, v.step_id AS stepId,
       COUNT(DISTINCT v.session_id) AS reached,
       COUNT(DISTINCT CASE WHEN EXISTS (
           SELECT 1 FROM events c
           WHERE c.session_id = v.session_id AND c.name = 'step_completed'
             AND json_extract(c.props_json, '$.next_step_id') = v.step_id
         ) THEN v.session_id END) AS edgeConverted,
       COUNT(DISTINCT CASE WHEN EXISTS (
           SELECT 1 FROM events st WHERE st.session_id = v.session_id AND st.name = 'session_started'
         ) THEN v.session_id END) AS entryConverted,
       COUNT(DISTINCT CASE WHEN NOT EXISTS (
           SELECT 1 FROM events o
           WHERE o.session_id = v.session_id AND o.name = 'step_completed' AND o.step_id = v.step_id
         ) AND NOT EXISTS (
           SELECT 1 FROM events r WHERE r.session_id = v.session_id AND r.name = 'result_viewed'
         ) THEN v.session_id END) AS dropOff
     FROM sessions s
     JOIN events v ON v.session_id = s.id
     WHERE v.name = 'step_viewed' AND v.step_id IS NOT NULL
       AND ${SESSION_FILTER}
     GROUP BY s.funnel_version, s.variant, v.step_id`,
  ).all(filter) as StepReachRow[];
}

export interface StepEligibleRow {
  version: number;
  variant: string;
  stepId: string;
  /** Eligible(S): distinct sessions with step_completed.next_step_id = S. */
  eligible: number;
}

/** Edge-based Eligible sets, grouped by (version, variant, next_step_id). */
export function analyticsStepEligible(db: DB, filter: AnalyticsFilter): StepEligibleRow[] {
  return stmt(
    db,
    `SELECT s.funnel_version AS version, s.variant AS variant,
       json_extract(e.props_json, '$.next_step_id') AS stepId,
       COUNT(DISTINCT e.session_id) AS eligible
     FROM sessions s
     JOIN events e ON e.session_id = s.id
     WHERE e.name = 'step_completed'
       AND json_extract(e.props_json, '$.next_step_id') IS NOT NULL
       AND ${SESSION_FILTER}
     GROUP BY s.funnel_version, s.variant, json_extract(e.props_json, '$.next_step_id')`,
  ).all(filter) as StepEligibleRow[];
}

/** Distinct sessions per event name, most common first. */
export function analyticsEventCounts(db: DB, filter: AnalyticsFilter): { name: string; sessions: number }[] {
  return stmt(
    db,
    `SELECT e.name AS name, COUNT(DISTINCT e.session_id) AS sessions
     FROM sessions s
     JOIN events e ON e.session_id = s.id
     WHERE ${SESSION_FILTER}
     GROUP BY e.name
     ORDER BY sessions DESC, e.name`,
  ).all(filter) as { name: string; sessions: number }[];
}

export function analyticsVersionNumbers(db: DB, funnelId: string): number[] {
  return (
    stmt(db, 'SELECT version FROM funnel_versions WHERE funnel_id = ? ORDER BY version').all(funnelId) as {
      version: number;
    }[]
  ).map((r) => r.version);
}

/** Distinct non-null first-touch campaigns across every version of the funnel. */
export function analyticsCampaigns(db: DB, funnelId: string): string[] {
  return (
    stmt(
      db,
      `SELECT DISTINCT s.utm_campaign AS campaign FROM sessions s
       WHERE s.funnel_id = ? AND s.utm_campaign IS NOT NULL ORDER BY s.utm_campaign`,
    ).all(funnelId) as { campaign: string }[]
  ).map((r) => r.campaign);
}

/** Funnel of the first stored version, for a database with no active version. */
export function analyticsAnyFunnelId(db: DB): string | null {
  const row = stmt(db, 'SELECT funnel_id FROM funnel_versions ORDER BY funnel_id, version LIMIT 1').get() as
    | { funnel_id: string }
    | undefined;
  return row?.funnel_id ?? null;
}
