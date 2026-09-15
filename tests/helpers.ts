import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '@shared/api';
import type { FunnelConfig } from '@shared/types';
import { buildApp } from '../src/server/app';
import type { DB } from '../src/server/db';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CONFIGS_DIR = join(ROOT, 'configs');
export const ADMIN_TOKEN = 'test-admin-token';

export const readConfigText = (relative: string): string => readFileSync(join(CONFIGS_DIR, relative), 'utf8');
export const readConfig = (relative: string): FunnelConfig => JSON.parse(readConfigText(relative)) as FunnelConfig;

export interface TestApp {
  app: FastifyInstance;
  db: DB;
  close(): Promise<void>;
}

/** The real Fastify app against a temp-file SQLite DB, boot-seeded from /configs. */
export async function createTestApp(): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'funnel-test-'));
  const app = await buildApp({ dbPath: join(dir, 'funnel.db'), adminToken: ADMIN_TOKEN, configsDir: CONFIGS_DIR });
  return {
    app,
    db: app.db,
    async close() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** `fsid=<uuid>` from an inject() response, for use as a `cookie` header. */
export function sessionCookie(response: { cookies: { name: string; value: string }[] }): string | undefined {
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
  return cookie ? `${SESSION_COOKIE}=${cookie.value}` : undefined;
}

export const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}` };
