/**
 * Business rules and value objects.
 *
 * Pure TypeScript by construction: no framework, no database driver, no I/O.
 * An ESLint boundary rule fails the build if any of those are imported here,
 * which is what keeps these rules testable without standing anything up — and
 * what stops a regulatory calculation from quietly acquiring a dependency on
 * the shape of an HTTP request.
 */

export { DomainError, DomainValidationError } from './errors.js';

export {
  AGE_BAND_LABELS,
  AGE_BAND_THRESHOLD_YEARS,
  ageBandAt,
  completedYearsBetween,
} from './client/age-band.js';
export type { AgeBand } from './client/age-band.js';

export { GENDERS, isGender, parseGender } from './client/gender.js';
export type { Gender } from './client/gender.js';

export { PhoneNumber } from './client/phone-number.js';
