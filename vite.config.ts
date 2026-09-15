import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors tsconfig.json `paths` — src/shared has no build step.
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
  },
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { outDir: 'dist' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
