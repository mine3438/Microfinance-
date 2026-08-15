import { Money } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import { applyEntry, balanceAsAt, reversalOf, type SavingsEntry } from './ledger.js';

/**
 * The savings ledger.
 *
 * Small on purpose. §13.4 has not settled interest, minimum balances or
 * withdrawal limits, so there is nothing here to test about them — and a suite
 * that appeared to cover savings rules while covering none would be worse than
 * one that covers what exists.
 */

const entry = (overrides: Partial<SavingsEntry> = {}): SavingsEntry => ({
  direction: 'deposit',
  amount: Money.of('50000.00'),
  transactionDate: '2026-05-10',
  ...overrides,
});

describe('applyEntry', () => {
  it('adds a deposit and subtracts a withdrawal', () => {
    const afterDeposit = applyEntry(Money.of('10000.00'), entry());
    expect(afterDeposit.toString()).toBe('60000.00');

    const afterWithdrawal = applyEntry(afterDeposit, entry({ direction: 'withdrawal' }));
    expect(afterWithdrawal.toString()).toBe('10000.00');
  });

  it('allows a withdrawal that empties the account exactly', () => {
    const emptied = applyEntry(Money.of('50000.00'), entry({ direction: 'withdrawal' }));

    expect(emptied.isZero()).toBe(true);
  });

  it('refuses a withdrawal that would overdraw the account', () => {
    // Not a product rule: a negative savings balance is an overdraft, which
    // would report money owed to a client as money owed by them.
    expect(() => applyEntry(Money.of('49999.99'), entry({ direction: 'withdrawal' }))).toThrow(
      DomainValidationError,
    );
  });

  it('refuses an entry of nothing', () => {
    expect(() => applyEntry(Money.of('10000.00'), entry({ amount: Money.zero() }))).toThrow(
      DomainValidationError,
    );
  });

  it('keeps the cent exactly', () => {
    // Three deposits that a double would not sum cleanly.
    let balance = Money.zero();
    for (const amount of ['0.10', '0.20', '0.30']) {
      balance = applyEntry(balance, entry({ amount: Money.of(amount) }));
    }

    expect(balance.toString()).toBe('0.60');
  });
});

describe('balanceAsAt', () => {
  it('answers as at a past date rather than as at today', () => {
    // The property MSP2-10 depends on: restating a filed quarter has to give
    // the figure that quarter had, not the figure the account has now.
    const entries = [
      entry({ amount: Money.of('100000.00'), transactionDate: '2026-03-01' }),
      entry({
        amount: Money.of('40000.00'),
        direction: 'withdrawal',
        transactionDate: '2026-04-15',
      }),
      entry({ amount: Money.of('25000.00'), transactionDate: '2026-07-02' }),
    ];

    expect(balanceAsAt(entries, '2026-03-31').toString()).toBe('100000.00');
    expect(balanceAsAt(entries, '2026-06-30').toString()).toBe('60000.00');
    expect(balanceAsAt(entries, '2026-09-30').toString()).toBe('85000.00');
  });

  it('is nil before the first entry', () => {
    expect(balanceAsAt([entry()], '2026-01-01').isZero()).toBe(true);
  });
});

describe('reversalOf', () => {
  it('undoes an entry with the opposite direction and the same amount', () => {
    const original = entry({ amount: Money.of('75000.00') });
    const reversal = reversalOf(original, '2026-05-20');

    expect(reversal.direction).toBe('withdrawal');
    expect(reversal.amount.toString()).toBe('75000.00');
    expect(applyEntry(applyEntry(Money.zero(), original), reversal).isZero()).toBe(true);
  });

  it('is dated when the correction was made, not when the mistake was', () => {
    const reversal = reversalOf(entry({ transactionDate: '2026-03-01' }), '2026-05-20');

    // Backdating a reversal into a filed quarter would change a figure BOT has
    // already been given.
    expect(reversal.transactionDate).toBe('2026-05-20');
  });
});
