import { Money } from '@mfi/money';

import { DomainValidationError } from '../errors.js';

/**
 * What a payment can be applied to.
 *
 * Penalties and fees are named here although nothing accrues them yet — the
 * penalty engine is a later stage. Naming them now is what makes the open
 * question visible: `01-ARCHITECTURE.md` §13.2 asks where they sit in the
 * order, and a type that could not express them would make the question
 * invisible rather than answered.
 */
export const ALLOCATION_BUCKETS = ['penalty', 'fee', 'interest', 'principal'] as const;

export type AllocationBucket = (typeof ALLOCATION_BUCKETS)[number];

/**
 * The order the supplied documentation specifies.
 *
 * TRD §4 describes the recorded behaviour as "interest-first, principal-second".
 * Those are the only two things a payment can currently be applied to, so this
 * order is documented rather than chosen.
 *
 * Where penalties and fees belong once they exist is **not** documented. The
 * conventional order is penalties → fees → interest → principal, and that is
 * what §13.2 proposes — but proposing is not deciding, so the order is a
 * parameter and this constant covers only what is known.
 */
export const DOCUMENTED_ALLOCATION_ORDER: readonly AllocationBucket[] = Object.freeze([
  'interest',
  'principal',
]);

/** What is owed, by bucket. Absent buckets are treated as nothing owed. */
export type OutstandingAmounts = Partial<Readonly<Record<AllocationBucket, Money>>>;

/** How a payment was applied. */
export interface PaymentAllocation {
  readonly amountPaid: Money;
  /** Applied per bucket, in the order they were consumed. */
  readonly applied: ReadonlyMap<AllocationBucket, Money>;
  /**
   * What the payment could not be applied to, because everything owed was
   * already covered.
   *
   * Recorded rather than absorbed. What an institution then does with the
   * excess — refund it, hold it as a credit, treat it as early settlement of a
   * future instalment — is an open business rule (§13.8). Silently keeping it
   * would be an answer to that question, and not one this system should give
   * on the institution's behalf.
   */
  readonly unallocated: Money;
}

export interface AllocationRequest {
  readonly amountPaid: Money;
  readonly outstanding: OutstandingAmounts;
  /** Defaults to {@link DOCUMENTED_ALLOCATION_ORDER}. */
  readonly order?: readonly AllocationBucket[];
}

/**
 * Apply a payment across what is owed.
 *
 * **The single implementation.** The system this replaces computed this split
 * twice — in an Edge Function that recorded the payment, and in the browser to
 * preview it — and its own TRD warned the preview would lie if the two drifted.
 * The preview endpoint and the write path both call this.
 *
 * Every amount is exact and the parts always sum to the payment. A split that
 * loses a shilling produces a balance nobody can reconcile, and reconciling a
 * borrower's account by hand is precisely what this product exists to stop.
 *
 * @throws {DomainValidationError} when the request cannot produce an allocation.
 */
export function allocatePayment(request: AllocationRequest): PaymentAllocation {
  const { amountPaid, outstanding } = request;
  const order = request.order ?? DOCUMENTED_ALLOCATION_ORDER;

  if (!amountPaid.isPositive()) {
    throw new DomainValidationError(
      `A payment must be positive, received ${amountPaid.toDatabaseValue()}. ` +
        'To undo a payment, record a reversal against it rather than a negative payment.',
    );
  }

  if (order.length === 0) {
    throw new DomainValidationError('An allocation order must name at least one bucket.');
  }

  const seen = new Set<AllocationBucket>();
  for (const bucket of order) {
    if (seen.has(bucket)) {
      throw new DomainValidationError(
        `Allocation order names ${bucket} more than once, so the split would be ambiguous.`,
      );
    }
    seen.add(bucket);
  }

  // Iterated over the known buckets rather than the object's own keys, so the
  // lookup is typed and an unrecognised key cannot slip through unchecked.
  for (const bucket of ALLOCATION_BUCKETS) {
    const owed = outstanding[bucket];
    if (owed === undefined) {
      continue;
    }
    if (owed.isNegative()) {
      throw new DomainValidationError(
        `Outstanding ${bucket} is negative (${owed.toDatabaseValue()}). ` +
          'A negative balance is a defect upstream, not something to allocate against.',
      );
    }
    if (!seen.has(bucket) && owed.isPositive()) {
      throw new DomainValidationError(
        `${owed.toDatabaseValue()} is outstanding as ${bucket}, but the allocation order ` +
          'does not include that bucket, so the payment could never reach it.',
      );
    }
  }

  const currency = amountPaid.currency;
  const applied = new Map<AllocationBucket, Money>();
  let remaining = amountPaid;

  for (const bucket of order) {
    const owed = outstanding[bucket] ?? Money.zero(currency);
    const toApply = Money.min(remaining, owed);

    applied.set(bucket, toApply);
    remaining = remaining.minus(toApply);
  }

  // The invariant. If it ever fails, a borrower's balance is wrong by exactly
  // the amount lost, and no report containing the loan will reconcile.
  const totalApplied = Money.sum([...applied.values()], currency);
  if (!totalApplied.plus(remaining).equals(amountPaid)) {
    throw new DomainValidationError(
      `Allocation of ${amountPaid.toDatabaseValue()} produced ` +
        `${totalApplied.toDatabaseValue()} applied plus ${remaining.toDatabaseValue()} unallocated. ` +
        'This is a defect in the allocator.',
    );
  }

  return { amountPaid, applied, unallocated: remaining };
}

/** What a bucket received, or zero if the allocation did not reach it. */
export function amountApplied(allocation: PaymentAllocation, bucket: AllocationBucket): Money {
  return allocation.applied.get(bucket) ?? Money.zero(allocation.amountPaid.currency);
}

/**
 * The balance a loan is left with after a payment.
 *
 * Only the principal component moves the balance. Interest, penalties and fees
 * are charges the payment settles; paying them does not reduce what was
 * borrowed.
 */
export function balanceAfter(balanceBefore: Money, allocation: PaymentAllocation): Money {
  const principalApplied = amountApplied(allocation, 'principal');

  if (principalApplied.greaterThan(balanceBefore)) {
    throw new DomainValidationError(
      `Allocation applied ${principalApplied.toDatabaseValue()} to principal against a balance ` +
        `of ${balanceBefore.toDatabaseValue()}. A payment cannot repay more principal than is owed.`,
    );
  }

  return balanceBefore.minus(principalApplied);
}
