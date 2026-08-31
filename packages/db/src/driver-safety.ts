import pg from 'pg';

import { UnsafeDriverConfigurationError } from './errors.js';

/**
 * PostgreSQL OIDs for the exact-numeric types money is stored in.
 *
 * `NUMERIC` is the one that matters — every monetary column is `NUMERIC(15,2)`
 * and every rate `NUMERIC(6,4)`. `INT8` is included because node-postgres also
 * returns bigints as strings to avoid precision loss beyond 2^53, and code that
 * assumes otherwise breaks the same way.
 */
const TYPE_OIDS = {
  numeric: 1700,
  int8: 20,
} as const;

/** A sentinel with more precision than a double can hold. */
const PRECISION_PROBE = '9007199254740993.01';

/**
 * Verify the driver returns exact numerics as strings.
 *
 * `@mfi/money` refuses to build an amount from a JavaScript number, because a
 * double cannot represent most decimal fractions. That guarantee is only
 * end-to-end if the driver hands `NUMERIC` back as a string. node-postgres does
 * by default — but one `pg.types.setTypeParser(1700, parseFloat)` anywhere in
 * the process, in any dependency, silently converts every balance in the system
 * to a float.
 *
 * There is no way to detect that after the fact: the damage is indistinguishable
 * from data that was always slightly wrong. So it is checked up front, and
 * checking is cheap.
 *
 * @throws {UnsafeDriverConfigurationError} if a parser returns anything but a string.
 */
export function assertExactNumericsAreSafe(): void {
  for (const [name, oid] of Object.entries(TYPE_OIDS)) {
    const parser: unknown = pg.types.getTypeParser(oid);

    if (typeof parser !== 'function') {
      throw new UnsafeDriverConfigurationError(
        `No type parser is registered for ${name} (OID ${String(oid)}). ` +
          'The driver cannot be trusted to return exact numeric values.',
      );
    }

    const parsed: unknown = (parser as (value: string) => unknown)(PRECISION_PROBE);

    if (typeof parsed !== 'string') {
      throw new UnsafeDriverConfigurationError(
        `The ${name} type parser (OID ${String(oid)}) returns ${typeof parsed}, not string. ` +
          'Monetary values would lose precision on every read. Remove the ' +
          `pg.types.setTypeParser(${String(oid)}, …) override — @mfi/money requires ` +
          'exact numerics to arrive as strings.',
      );
    }

    if (parsed !== PRECISION_PROBE) {
      throw new UnsafeDriverConfigurationError(
        `The ${name} type parser altered its input: ${PRECISION_PROBE} became ${parsed}. ` +
          'Exact numeric values must pass through unchanged.',
      );
    }
  }
}

/** OIDs checked by {@link assertExactNumericsAreSafe}. Exported for tests. */
export { TYPE_OIDS };
