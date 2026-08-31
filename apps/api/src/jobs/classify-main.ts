import process from 'node:process';

import { runClassification } from './classify.js';

/**
 * Entry point for the scheduled classification.
 *
 * Separate from `classify.ts` so the job can be called by a test without the
 * test ending the process.
 */
runClassification().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
