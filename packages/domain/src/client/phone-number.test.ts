import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import { PhoneNumber } from './phone-number.js';

describe('parsing the forms users actually type', () => {
  it.each([
    ['local with leading zero', '0712345678'],
    ['international with plus', '+255712345678'],
    ['international without plus', '255712345678'],
    ['spaced', '0712 345 678'],
    ['hyphenated', '0712-345-678'],
    ['bracketed', '(0712) 345 678'],
    ['international and spaced', '+255 712 345 678'],
  ])('accepts a %s number', (_label, input) => {
    expect(PhoneNumber.parse(input).toDatabaseValue()).toBe('+255712345678');
  });

  it('normalises every accepted form to the same value', () => {
    // The failure this prevents: the same person existing twice, once as
    // 0712345678 and once as +255712345678, with two client codes and two loan
    // histories that no report will reconcile.
    const forms = ['0712345678', '+255712345678', '255712345678', '0712 345 678'];
    const normalised = new Set(forms.map((form) => PhoneNumber.parse(form).toDatabaseValue()));

    expect(normalised.size).toBe(1);
  });

  it('accepts 06 numbers, which the previous system rejected', () => {
    // The schema reference described validation as `07xxxxxxxx` only, which
    // turns away every 06 subscriber — a large share of the Tanzanian market.
    expect(PhoneNumber.parse('0654321098').toDatabaseValue()).toBe('+255654321098');
  });
});

describe('rejecting what is not a Tanzanian mobile', () => {
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['too short', '071234567'],
    ['too long', '07123456789'],
    ['a landline', '0222123456'],
    ['a prefix that is not mobile', '0812345678'],
    ['another country', '+254712345678'],
    ['letters', '07ABCDEFGH'],
    ['no recognisable prefix', '712345678'],
  ])('rejects %s', (_label, input) => {
    expect(() => PhoneNumber.parse(input)).toThrow(DomainValidationError);
  });

  it('names the accepted forms in the error, so the fix is obvious', () => {
    expect(() => PhoneNumber.parse('12345')).toThrow(/0712345678/);
  });

  it('reports validity without throwing', () => {
    expect(PhoneNumber.isValid('0712345678')).toBe(true);
    expect(PhoneNumber.isValid('nonsense')).toBe(false);
  });
});

describe('reading a stored value', () => {
  it('accepts a value in canonical form', () => {
    expect(PhoneNumber.fromDatabaseValue('+255712345678').toDatabaseValue()).toBe('+255712345678');
  });

  it.each([
    ['local form', '0712345678'],
    ['no plus', '255712345678'],
    ['another country', '+254712345678'],
    ['empty', ''],
  ])('rejects a stored %s rather than re-normalising it', (_label, stored) => {
    // Asserting the invariant rather than establishing it: a value that reached
    // storage in the wrong shape means something wrote past the domain, and
    // silently fixing it would hide that.
    expect(() => PhoneNumber.fromDatabaseValue(stored)).toThrow(/E\.164|bypassed/);
  });
});

describe('presentation', () => {
  it('renders the way Tanzanians read a number aloud', () => {
    expect(PhoneNumber.parse('+255712345678').toLocalFormat()).toBe('0712 345 678');
  });

  it('serialises to canonical form in JSON', () => {
    expect(JSON.stringify({ phone: PhoneNumber.parse('0712345678') })).toBe(
      '{"phone":"+255712345678"}',
    );
  });

  it('compares by value', () => {
    expect(PhoneNumber.parse('0712345678').equals(PhoneNumber.parse('+255712345678'))).toBe(true);
    expect(PhoneNumber.parse('0712345678').equals(PhoneNumber.parse('0787654321'))).toBe(false);
  });
});
