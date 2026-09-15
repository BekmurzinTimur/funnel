import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type DB = Database.Database;

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

/** Opens the database and applies schema.sql (idempotent CREATE ... IF NOT EXISTS). */
export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}
