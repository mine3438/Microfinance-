import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Argon2 is intentionally slow; the default 5s timeout is tight for a suite
    // that hashes repeatedly.
    testTimeout: 30_000,
  },
});
