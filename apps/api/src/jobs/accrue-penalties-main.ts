import process from 'node:process';

import { runPenaltyAccrual } from './accrue-penalties.js';

/** Entry point for the scheduled penalty accrual. See `accrue-penalties.ts`. */
runPenaltyAccrual().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
