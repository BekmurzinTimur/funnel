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
