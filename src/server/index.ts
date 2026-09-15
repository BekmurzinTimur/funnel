import { resolve } from 'node:path';
import { buildApp } from './app';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? './data/funnel.db';

let adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  if (production) {
    console.error('ADMIN_TOKEN must be set in production.');
    process.exit(1);
  }
  adminToken = 'dev-admin-token';
  console.warn('ADMIN_TOKEN not set; using "dev-admin-token" for local development.');
}

const app = await buildApp({
  dbPath,
  adminToken,
  configsDir: resolve('configs'),
  staticDir: resolve('dist'),
  logger: true,
});

await app.listen({ port, host: '0.0.0.0' });
