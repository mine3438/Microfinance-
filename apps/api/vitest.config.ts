import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Suites share one test database and one Redis; parallel files would
    // interleave fixtures and rate-limit counters.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
