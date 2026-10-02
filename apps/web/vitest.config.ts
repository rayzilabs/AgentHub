import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    include: ['test/**/*.test.ts'],
  },
});
