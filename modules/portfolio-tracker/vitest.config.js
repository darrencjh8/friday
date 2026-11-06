import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Node's own test runner, not vitest: the dependency-free RED control.
    exclude: [...configDefaults.exclude, 'tests/loan-loader.test.mjs', 'tests/loan-repro-147.test.js'],
  },
});
