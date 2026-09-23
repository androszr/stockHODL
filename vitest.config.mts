import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    /**
     * `node` stays the DEFAULT, deliberately: every module in `src/lib` is
     * pure or has an injectable IO seam, and a DOM under those tests would
     * cost seconds for nothing.
     */
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
