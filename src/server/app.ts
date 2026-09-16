import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { bootSeed } from './bootSeed';
import { openDb, type DB } from './db';
import adminRoutes from './routes/admin';
import analyticsRoutes from './routes/analytics';
import eventRoutes from './routes/events';
import sessionRoutes from './routes/session';

export interface AppOptions {
  dbPath: string;
  configsDir: string;
  /** Built SPA directory. Omit or null to serve the API only (tests). */
  staticDir?: string | null;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
  }
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const db = openDb(options.dbPath);
  const seeded = bootSeed(db, options.configsDir);

  const app = Fastify({ logger: options.logger ?? false });
  if (seeded.length) app.log.info({ seeded }, 'boot-seeded funnel versions');

  app.decorate('db', db);
  app.addHook('onClose', async () => db.close());

  // navigator.sendBeacon may arrive as text/plain; treat it as JSON.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch (err) {
      // Malformed JSON is the client's fault, same as for application/json.
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  await app.register(cookie);
  app.get('/api/health', async () => ({ ok: true }));
  await app.register(sessionRoutes, { prefix: '/api' });
  await app.register(eventRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });
  await app.register(analyticsRoutes, { prefix: '/api' });

  const staticDir = options.staticDir ? resolve(options.staticDir) : null;
  const serveSpa = staticDir !== null && existsSync(join(staticDir, 'index.html'));
  if (serveSpa) await app.register(fastifyStatic, { root: staticDir });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0];
    const looksLikeFile = /\.[a-z0-9]+$/i.test(path);
    if (serveSpa && request.method === 'GET' && !path.startsWith('/api') && !looksLikeFile) {
      return reply.sendFile('index.html'); // SPA fallback for /admin, /dashboard
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  return app;
}
