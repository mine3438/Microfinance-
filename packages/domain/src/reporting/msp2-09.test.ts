import { Money } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { compileMsp2_09, type Disbursement } from './msp2-09.js';

const SECTORS = ['agriculture', 'trade'];

const disbursement = (overrides: Partial<Disbursement> = {}): Disbursement => ({
  sectorCode: 'agriculture',
  gender: 'female',
  principal: Money.of('500000'),
  ...overrides,
});

describe('compileMsp2_09', () => {
  it('splits disbursements by gender within a sector', () => {
    const form = compileMsp2_09({
      sectorCodes: SECTORS,
      disbursements: [
        disbursement({ gender: 'female', principal: Money.of('300000') }),
        disbursement({ gender: 'female', principal: Money.of('200000') }),
        disbursement({ gender: 'male', principal: Money.of('700000') }),
      ],
    });

    const agriculture = form.rows[0]!;
    expect(agriculture.female).toEqual({ count: 2, amount: Money.of('500000') });
    expect(agriculture.male.count).toBe(1);
    expect(agriculture.male.amount.toDatabaseValue()).toBe('700000.00');
  });

  it('totals each row from its two gender columns', () => {
    // BOT validates that the total equals the parts. Deriving it any other way
    // creates a figure that can disagree with the columns beside it.
    const form = compileMsp2_09({
      sectorCodes: SECTORS,
      disbursements: [disbursement({ gender: 'female' }), disbursement({ gender: 'male' })],
    });

    expect(form.rows[0]?.total.count).toBe(2);
    expect(form.rows[0]?.total.amount.toDatabaseValue()).toBe('1000000.00');
  });

  it('reports the principal advanced, not what remains owing', () => {
    // This form is a flow, not a balance. A loan advanced in January and half
    // repaid by March still reports its full principal.
    const form = compileMsp2_09({
      sectorCodes: SECTORS,
      disbursements: [disbursement({ principal: Money.of('1000000') })],
    });

    expect(form.rows[0]?.female.amount.toDatabaseValue()).toBe('1000000.00');
  });

  it('produces a row for every published sector', () => {
    const form = compileMsp2_09({ sectorCodes: SECTORS, disbursements: [] });

    expect(form.rows.map((row) => row.sectorCode)).toEqual(SECTORS);
    expect(form.total.total.count).toBe(0);
  });

  it('refuses a sector BOT does not publish', () => {
    expect(() =>
      compileMsp2_09({
        sectorCodes: SECTORS,
        disbursements: [disbursement({ sectorCode: 'invented' })],
      }),
    ).toThrow(/not one BOT publishes/);
  });
});
