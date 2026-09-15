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
