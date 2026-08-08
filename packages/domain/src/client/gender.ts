import { DomainValidationError } from '../errors.js';

/**
 * The genders BOT's returns provide columns for.
 *
 * MSP2-09 splits loans disbursed into `Female` and `Male`; MSP2-10 crosses the
 * same two with age band. There is no third column and no unknown column, so a
 * borrower recorded as anything else could not be placed on either return.
 *
 * This is a constraint imposed by the regulator's form, not a position taken by
 * this system. It is recorded here explicitly so that it reads as what it is —
 * an external requirement — rather than as an unexamined default.
 */
export const GENDERS = ['male', 'female'] as const;

export type Gender = (typeof GENDERS)[number];

/** Narrow an arbitrary string to a gender BOT can report. */
export function isGender(value: string): value is Gender {
  return (GENDERS as readonly string[]).includes(value);
}

/**
 * Parse a gender, rejecting anything the returns cannot represent.
 *
 * @throws {DomainValidationError} when the value is not male or female.
 */
export function parseGender(value: string): Gender {
  const normalised = value.trim().toLowerCase();
  if (!isGender(normalised)) {
    throw new DomainValidationError(
      `"${value}" is not a gender BOT's returns can represent. ` +
        `MSP2-09 and MSP2-10 provide columns for ${GENDERS.join(' and ')} only.`,
    );
  }
  return normalised;
}
