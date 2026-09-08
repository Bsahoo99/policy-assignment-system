import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // PGlite boots a WASM Postgres per file; parallel instantiation across 12
    // test files exceeds the default 10s hook timeout on a laptop.
    hookTimeout: 30000,
    testTimeout: 30000,
    maxWorkers: 2,
  },
  resolve: {
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
    },
  },
});
