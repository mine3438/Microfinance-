import { describe, expect, it } from 'vitest';

import {
  compareDecimalStrings,
  emailSchema,
  isoDateSchema,
  isoTimestampSchema,
  moneyAmountSchema,
  nonNegativeMoneyAmountSchema,
  percentageSchema,
  positiveMoneyAmountSchema,
  rateFractionSchema,
  requiredTextSchema,
  uuidSchema,
} from './scalars.js';

describe('moneyAmountSchema', () => {
  it.each([
    ['0', 'zero'],
    ['1', 'a bare unit'],
    ['0.01', 'the smallest representable amount'],
    ['1500000.50', 'a typical loan repayment'],
    ['9999999999999.99', 'the largest NUMERIC(15,2) value'],
    ['-500.25', 'a negative amount, for reversals'],
    ['100.5', 'one decimal place'],
  ])('accepts %s (%s)', (value) => {
    expect(moneyAmountSchema.parse(value)).toBe(value);
  });

  it.each([
    ['1.005', 'more precision than the currency has'],
    ['1,500,000', 'thousands separators'],
    ['1.5e6', 'exponent notation'],
    ['TZS 500', 'a currency symbol'],
    ['10000000000000', 'fourteen integer digits, beyond NUMERIC(15,2)'],
    ['007', 'leading zeros'],
    ['', 'the empty string'],
    [' 100 ', 'surrounding whitespace'],
    ['.5', 'no integer part'],
    ['100.', 'a trailing point'],
    ['Infinity', 'a non-finite word'],
    ['NaN', 'not a number at all'],
    ['-0', 'negative zero'],
    ['-0.00', 'negative zero with places'],
  ])('rejects %s (%s)', (value) => {
    expect(moneyAmountSchema.safeParse(value).success).toBe(false);
  });

  it('rejects a JSON number, explaining why rather than only what', () => {
    const result = moneyAmountSchema.safeParse(1500000.5);

    expect(result.success).toBe(false);
    // The message has to carry the reason: by the time a float arrives the
    // precision is already gone and no amount of server-side care recovers it.
    expect(result.error?.issues[0]?.message).toContain('binary doubles');
  });

  it('rejects the classic float artefact even though it looks like a number', () => {
    // 0.1 + 0.2 === 0.30000000000000004. A client that computed a total in
    // JavaScript and stringified it lands here, and it must not pass.
    expect(moneyAmountSchema.safeParse(String(0.1 + 0.2)).success).toBe(false);
  });

  it('names the field as required when the value is absent', () => {
    const result = moneyAmountSchema.safeParse(undefined);

    expect(result.error?.issues[0]?.message).toContain('required');
  });
});

describe('positiveMoneyAmountSchema', () => {
  it('accepts an amount above zero', () => {
    expect(positiveMoneyAmountSchema.parse('0.01')).toBe('0.01');
  });

  it.each(['0', '0.00', '-1.00'])('rejects %s', (value) => {
    expect(positiveMoneyAmountSchema.safeParse(value).success).toBe(false);
  });
});

describe('nonNegativeMoneyAmountSchema', () => {
  it('accepts zero', () => {
    expect(nonNegativeMoneyAmountSchema.parse('0.00')).toBe('0.00');
  });

  it('rejects a negative amount', () => {
    expect(nonNegativeMoneyAmountSchema.safeParse('-0.01').success).toBe(false);
  });
});

describe('rateFractionSchema', () => {
  it.each(['0', '0.05', '0.0417', '1', '99.9999'])('accepts %s', (value) => {
    expect(rateFractionSchema.parse(value)).toBe(value);
  });

  it.each([
    ['0.00001', 'beyond NUMERIC(6,4)'],
    ['-0.05', 'a negative rate'],
    ['100', 'three integer digits, beyond NUMERIC(6,4)'],
  ])('rejects %s (%s)', (value) => {
    expect(rateFractionSchema.safeParse(value).success).toBe(false);
  });

  it('rejects a number, since a rate loses precision as a double just as money does', () => {
    expect(rateFractionSchema.safeParse(0.05).success).toBe(false);
  });
});

describe('percentageSchema', () => {
  it('accepts a percentage written as people write it', () => {
    expect(percentageSchema.parse('5')).toBe('5');
  });

  it('is a separate schema from the rate schema, so the two cannot be swapped silently', () => {
    // 5% as a percentage is "5"; as a rate fraction it is "0.05". Each schema
    // accepts the other's spelling as a number in its own units, which is
    // precisely why they must not share one definition — a hundred-fold error
    // in an interest calculation is not detectable downstream.
    expect(percentageSchema.parse('5')).toBe('5');
    expect(rateFractionSchema.parse('0.05')).toBe('0.05');
    expect(percentageSchema.safeParse('1000').success).toBe(false);
  });
});

describe('emailSchema', () => {
  it('lowercases, matching the lower(email) unique index', () => {
    expect(emailSchema.parse('Officer@Institution.CO.TZ')).toBe('officer@institution.co.tz');
  });

  it('trims surrounding whitespace, which a paste commonly carries', () => {
    expect(emailSchema.parse('  officer@x.co.tz  ')).toBe('officer@x.co.tz');
  });

  it.each(['not-an-email', '@x.co.tz', 'officer@', ''])('rejects %s', (value) => {
    expect(emailSchema.safeParse(value).success).toBe(false);
  });

  it('rejects an address beyond the addressable maximum', () => {
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@x.co.tz`).success).toBe(false);
  });
});

describe('uuidSchema', () => {
  it('accepts a v7 identifier, which is what the schema generates', () => {
    const identifier = '01930000-0000-7000-8000-000000000000';
    expect(uuidSchema.parse(identifier)).toBe(identifier);
  });

  it('accepts a v4 identifier, so identifiers issued before any generator change stay valid', () => {
    const identifier = '4b9a1f2c-1234-4abc-8def-0123456789ab';
    expect(uuidSchema.parse(identifier)).toBe(identifier);
  });

  it.each(['1', 'not-a-uuid', '01930000-0000-7000-8000-00000000000'])('rejects %s', (value) => {
    expect(uuidSchema.safeParse(value).success).toBe(false);
  });
});

describe('isoDateSchema', () => {
  it('accepts a quarter end', () => {
    expect(isoDateSchema.parse('2026-03-31')).toBe('2026-03-31');
  });

  it('accepts 29 February in a leap year', () => {
    expect(isoDateSchema.parse('2024-02-29')).toBe('2024-02-29');
  });

  it('rejects 29 February in a common year rather than rolling it into March', () => {
    // `new Date('2025-02-29')` silently becomes 1 March. A due date that moves
    // by a day can move a repayment across a quarter boundary on a BOT return.
    expect(isoDateSchema.safeParse('2025-02-29').success).toBe(false);
  });

  it.each([
    ['2026-13-01', 'a thirteenth month'],
    ['2026-04-31', 'a thirty-first of April'],
    ['2026-3-31', 'an unpadded month'],
    ['2026-03-31T00:00:00Z', 'a timestamp where a calendar date belongs'],
  ])('rejects %s (%s)', (value) => {
    expect(isoDateSchema.safeParse(value).success).toBe(false);
  });
});

describe('isoTimestampSchema', () => {
  it('accepts a UTC instant', () => {
    expect(isoTimestampSchema.parse('2026-03-31T14:30:00.000Z')).toBe('2026-03-31T14:30:00.000Z');
  });

  it('rejects an instant carrying a non-UTC offset', () => {
    expect(isoTimestampSchema.safeParse('2026-03-31T14:30:00+03:00').success).toBe(false);
  });
});

describe('requiredTextSchema', () => {
  it('trims and keeps the remainder', () => {
    expect(requiredTextSchema(50).parse('  Amina Hassan  ')).toBe('Amina Hassan');
  });

  it('rejects text that is only whitespace, which a length check alone would admit', () => {
    expect(requiredTextSchema(50).safeParse('   ').success).toBe(false);
  });

  it('enforces the maximum it was given', () => {
    expect(requiredTextSchema(5).safeParse('123456').success).toBe(false);
  });
});

describe('compareDecimalStrings', () => {
  const ordering = (left: string, right: string): number =>
    Math.sign(compareDecimalStrings(left, right));

  it.each([
    ['2', '1', 'a larger whole part'],
    ['10', '9', 'a longer whole part, which lexicographic order would get wrong'],
    ['1.50', '1.05', 'a larger fraction under an equal whole part'],
    ['0.1', '0.09', 'a shorter fraction that is nonetheless larger'],
    ['1500000.50', '1500000.49', 'a difference of one cent'],
    ['0', '-1', 'zero against a negative'],
    ['-1', '-2', 'the less negative of two negatives'],
  ])('orders %s above %s (%s)', (larger, smaller) => {
    expect(ordering(larger, smaller)).toBe(1);
    expect(ordering(smaller, larger)).toBe(-1);
  });

  it.each([
    ['1', '1', 'the same spelling'],
    ['1.5', '1.50', 'a trailing zero, which does not change the value'],
    ['1', '1.00', 'a fraction present on one side only'],
    ['0', '0.00', 'zero written two ways'],
  ])('calls %s equal to %s (%s)', (left, right) => {
    expect(ordering(left, right)).toBe(0);
  });

  it('holds across the whole width of a stored amount', () => {
    // Thirteen digits before the point and two after — the widest value
    // `NUMERIC(15,2)` accepts — differing only in the last cent.
    expect(ordering('9999999999999.99', '9999999999999.98')).toBe(1);
  });

  it('separates values that differ beyond a double, where the pattern one day might not', () => {
    // Not a value `moneyAmountSchema` accepts today, and that is what this test
    // is for. `Number` collapses these two onto one; the comparator does not.
    // If the money pattern ever widens, the range checks built on this keep
    // working rather than quietly starting to admit a nonsensical product.
    const left = '9007199254740993';
    const right = '9007199254740992';

    expect(Number(left) === Number(right)).toBe(true);
    expect(ordering(left, right)).toBe(1);
  });
});
