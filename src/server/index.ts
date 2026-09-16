import { resolve } from 'node:path';
import { buildApp } from './app';

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? './data/funnel.db';

const app = await buildApp({
  dbPath,
  configsDir: resolve('configs'),
  staticDir: resolve('dist'),
  logger: true,
});

await app.listen({ port, host: '0.0.0.0' });
