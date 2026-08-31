import { type Principal } from '@mfi/identity';

import { ruleViolation } from '../../http/errors.js';
import { type AccrualOutcome, type PenaltyRepository } from './penalty-repository.js';

/**
 * Running the accrual.
 *
 * Dated rather than "now", and refused for a future date: penalty for days that
 * have not happened is not owed. A past date is allowed, because a book that
 * has not been accrued for a week has to be caught up to today one date at a
 * time or in one step, and both give the same answer — the watermark makes the
 * operation idempotent either way.
 */
export async function accruePenalties(
  principal: Principal,
  asAt: string,
  penalties: PenaltyRepository,
  now: () => Date = () => new Date(),
): Promise<AccrualOutcome> {
  const today = now().toISOString().slice(0, 10);
  if (asAt > today) {
    throw ruleViolation(
      `Penalty cannot be accrued to ${asAt}, which has not happened yet. Today is ${today}.`,
    );
  }

  return penalties.accrueTo(principal.institutionId, principal.userId, asAt);
}
