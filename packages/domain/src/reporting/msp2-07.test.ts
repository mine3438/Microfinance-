import { Money } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import { compileMsp2_08 } from './msp2-08.js';
import { HOLDING_KINDS, compileMsp2_07, type CounterpartyHolding } from './msp2-07.js';

const nil = Money.zero();

const holding = (
  kind: CounterpartyHolding['kind'],
  counterparty: string,
  amounts: Partial<Omit<CounterpartyHolding, 'kind' | 'counterparty'>> = {},
): CounterpartyHolding => ({
  kind,
  counterparty,
  depositTzs: nil,
  borrowingTzs: nil,
  depositForeignTzsEquivalent: nil,
  borrowingForeignTzsEquivalent: nil,
  ...amounts,
});

describe('compileMsp2_07', () => {
  it('prints all four sections even when nothing is held in them', () => {
    // BOT's template prints four, and an absent section reads as a missing
    // figure rather than a nil one.
    const form = compileMsp2_07({ holdings: [] });

    expect(form.sections.map((section) => section.kind)).toEqual([...HOLDING_KINDS]);
    expect(form.total.depositTotal.toDatabaseValue()).toBe('0.00');
  });

  it('adds the TZS and foreign columns into each row total', () => {
    const form = compileMsp2_07({
      holdings: [
        holding('bank_tanzania', 'CRDB BANK PLC', {
          depositTzs: Money.of('4000000.00'),
          depositForeignTzsEquivalent: Money.of('2500000.00'),
        }),
      ],
    });

    const row = form.sections[0]?.rows[0];
    expect(row?.depositTotal.toDatabaseValue()).toBe('6500000.00');
  });

  it('keeps deposits and borrowings apart', () => {
    const form = compileMsp2_07({
      holdings: [
        holding('bank_tanzania', 'NBC LIMITED', {
          depositTzs: Money.of('1000000.00'),
          borrowingTzs: Money.of('7500000.00'),
        }),
      ],
    });

    // The same counterparty holds a deposit and owes a borrowing. Netting them
    // would report neither figure BOT asked for.
    expect(form.total.depositTotal.toDatabaseValue()).toBe('1000000.00');
    expect(form.total.borrowingTotal.toDatabaseValue()).toBe('7500000.00');
  });

  it('subtotals each section and totals the sections', () => {
    const form = compileMsp2_07({
      holdings: [
        holding('bank_tanzania', 'CRDB BANK PLC', { depositTzs: Money.of('1000000.00') }),
        holding('bank_tanzania', 'NBC LIMITED', { depositTzs: Money.of('500000.00') }),
        holding('mno', 'MPESA', { depositTzs: Money.of('250000.00') }),
      ],
    });

    const banks = form.sections.find((section) => section.kind === 'bank_tanzania');
    const mnos = form.sections.find((section) => section.kind === 'mno');

    expect(banks?.subtotal.depositTotal.toDatabaseValue()).toBe('1500000.00');
    expect(mnos?.subtotal.depositTotal.toDatabaseValue()).toBe('250000.00');
    expect(form.total.depositTotal.toDatabaseValue()).toBe('1750000.00');
  });

  it('refuses the same counterparty twice in one section', () => {
    // Two rows would split a balance BOT reads as one, and the total would
    // still look right — which is what makes it worth refusing.
    expect(() =>
      compileMsp2_07({
        holdings: [
          holding('bank_tanzania', 'CRDB BANK PLC', { depositTzs: Money.of('100.00') }),
          holding('bank_tanzania', 'crdb bank plc', { depositTzs: Money.of('200.00') }),
        ],
      }),
    ).toThrow(DomainValidationError);
  });

  it('allows the same name under two different sections', () => {
    // A microfinance provider abroad and one in Tanzania may share a name;
    // they are different rows on different sections of the form.
    expect(() =>
      compileMsp2_07({
        holdings: [
          holding('microfinance_service_provider', 'Faraja'),
          holding('bank_abroad', 'Faraja'),
        ],
      }),
    ).not.toThrow();
  });
});

describe('compileMsp2_08', () => {
  const CODES = ['crdb_bank_plc', 'nbc_limited'];

  it('prints a row for every bank on BOT’s agent-banking list', () => {
    const form = compileMsp2_08({ institutionCodes: CODES, balances: [] });

    expect(form.rows.map((row) => row.institutionCode)).toEqual(CODES);
    expect(form.total.toDatabaseValue()).toBe('0.00');
  });

  it('totals the balances', () => {
    const form = compileMsp2_08({
      institutionCodes: CODES,
      balances: [
        { institutionCode: 'crdb_bank_plc', balance: Money.of('3000000.00') },
        { institutionCode: 'nbc_limited', balance: Money.of('1500000.50') },
      ],
    });

    expect(form.total.toDatabaseValue()).toBe('4500000.50');
  });

  it('refuses a balance against a bank BOT does not list for agent banking', () => {
    expect(() =>
      compileMsp2_08({
        institutionCodes: CODES,
        balances: [{ institutionCode: 'bank_of_tanzania', balance: Money.of('1.00') }],
      }),
    ).toThrow(/agent-banking list/);
  });

  it('refuses to compile without the institution list', () => {
    expect(() => compileMsp2_08({ institutionCodes: [], balances: [] })).toThrow(
      DomainValidationError,
    );
  });
});
