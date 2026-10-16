import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // No test may reach a real LLM provider (see the file for why).
    setupFiles: ['./tests/setup/no-network-llm.js'],
    globals: true,
    // The dedup journal fsyncs on every commit, which costs ~300ms per fsync
    // on this container's overlay filesystem. Tests open a throwaway DB per
    // case, so they were paying ~0.9s of pure fsync per test and blowing the
    // 5s default testTimeout under parallel load. This flag is read only by
    // src/dedup.js and switches the journal to synchronous=OFF for tests.
    // Production never sets it, so its durability is unchanged.
    env: {
      EXPENSE_DEDUP_TEST_FAST: "1",
    },
  },
});
