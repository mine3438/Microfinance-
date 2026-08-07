import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Every file shares one test database and asserts against its catalog.
    // Parallel files would interleave DDL and role changes.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
