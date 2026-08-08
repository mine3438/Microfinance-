import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import { GENDERS, isGender, parseGender } from './gender.js';

describe('gender', () => {
  it.each(['male', 'female'])('accepts %s', (value) => {
    expect(parseGender(value)).toBe(value);
  });

  it('normalises case and surrounding whitespace', () => {
    expect(parseGender('  Female ')).toBe('female');
    expect(parseGender('MALE')).toBe('male');
  });

  it.each(['', 'other', 'non-binary', 'unknown', 'f', 'm'])('rejects %j', (value) => {
    // Not a position this system takes. MSP2-09 and MSP2-10 provide exactly two
    // columns, so a borrower recorded as anything else could not be placed on
    // either return. The error says so, rather than failing silently.
    expect(() => parseGender(value)).toThrow(DomainValidationError);
  });

  it('explains that the constraint comes from BOT’s returns', () => {
    expect(() => parseGender('other')).toThrow(/MSP2-09 and MSP2-10/);
  });

  it('narrows without throwing', () => {
    expect(isGender('female')).toBe(true);
    expect(isGender('other')).toBe(false);
  });

  it('offers exactly the two values the returns have columns for', () => {
    expect([...GENDERS]).toEqual(['male', 'female']);
  });
});
