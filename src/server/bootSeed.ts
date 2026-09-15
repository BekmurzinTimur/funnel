import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from '@shared/config.schema';
import type { DB } from './db';
import { ensureActiveVersion, getVersion, insertVersion, nowIso } from './queries';

/**
 * §9: insert each `*.json` directly in configsDir (not subdirectories) whose
 * (funnel_id, version) is absent, then activate the lowest version if none is
 * active. Never generates traffic.
 */
export function bootSeed(db: DB, configsDir: string): string[] {
  const inserted: string[] = [];
  if (existsSync(configsDir)) {
    const files = readdirSync(configsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();

    for (const file of files) {
      const text = readFileSync(join(configsDir, file), 'utf8');
      const result = validateConfig(JSON.parse(text));
      if (!result.ok) throw new Error(`configs/${file} failed validation:\n  ${result.errors.join('\n  ')}`);
      const { funnelId, version, schemaVersion } = result.config;
      if (getVersion(db, funnelId, version)) continue;
      insertVersion(db, {
        funnel_id: funnelId,
        version,
        config_json: text,
        schema_version: schemaVersion,
        created_at: nowIso(),
      });
      inserted.push(`${funnelId}@${version}`);
    }
  }
  ensureActiveVersion(db);
  return inserted;
}
