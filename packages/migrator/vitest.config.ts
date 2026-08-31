import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Migration tests share one Postgres instance and create/drop schemas by name.
    // Running files in parallel would interleave those DDL statements.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
