-- Foundation: identifier generation, timestamp maintenance, and the least-privilege
-- application role that row-level security is enforced against.
--
-- Nothing here is domain-specific. Every later migration builds on these pieces.

-- ---------------------------------------------------------------------------
-- Identifiers
-- ---------------------------------------------------------------------------

-- Time-ordered UUIDs (RFC 9562 version 7).
--
-- Random version-4 UUIDs scatter inserts across a B-tree, dirtying a new page
-- per row and inflating both write amplification and index size. Version 7
-- leads with a millisecond timestamp, so new rows append to the right edge of
-- the index the way a sequence would, while staying globally unique and
-- non-guessable.
--
-- The 12 `rand_a` bits are filled with sub-millisecond precision rather than
-- randomness — permitted by RFC 9562 §6.2 method 3 — which makes the values
-- strictly increasing even for rows created within the same millisecond.
-- Without it, ordering only holds between milliseconds and a burst of inserts
-- still scatters.
--
-- PostgreSQL 18 ships a built-in `uuidv7()`; this exists because the target is
-- PostgreSQL 16.
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  epoch_ms   numeric;
  ts_ms      bigint;
  sub_ms     integer;
  uuid_bytes bytea;
BEGIN
  epoch_ms := extract(epoch FROM clock_timestamp()) * 1000;
  ts_ms    := floor(epoch_ms);
  sub_ms   := floor((epoch_ms - ts_ms) * 4096);   -- 12 bits of sub-millisecond precision

  -- Bytes 0-5: timestamp. Bytes 6-15: random, taken from a v4 UUID so that no
  -- extension is required (pgcrypto's gen_random_bytes is not always available).
  uuid_bytes := substring(int8send(ts_ms) FROM 3) || substring(uuid_send(gen_random_uuid()) FROM 7);

  -- Byte 6: version 7 in the high nibble, sub-millisecond counter high bits in the low nibble.
  uuid_bytes := set_byte(uuid_bytes, 6, 112 | (sub_ms >> 8));
  -- Byte 7: sub-millisecond counter low bits.
  uuid_bytes := set_byte(uuid_bytes, 7, sub_ms & 255);
  -- Byte 8: RFC 9562 variant (binary 10) in the top two bits.
  uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);

  RETURN encode(uuid_bytes, 'hex')::uuid;
END;
$$;

COMMENT ON FUNCTION uuid_generate_v7() IS
  'RFC 9562 version 7 UUID: millisecond timestamp plus sub-millisecond counter, then random bits.';

-- ---------------------------------------------------------------------------
-- Timestamp maintenance
-- ---------------------------------------------------------------------------

-- Keeps `updated_at` honest.
--
-- Attached as a BEFORE UPDATE trigger so the column cannot be back-dated or
-- forgotten by application code. `updated_at` is evidence of when a record
-- changed, and evidence the writer can set is not evidence.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at() IS
  'BEFORE UPDATE trigger function: stamps updated_at with the transaction clock.';

-- ---------------------------------------------------------------------------
-- Application role
-- ---------------------------------------------------------------------------

-- The role the application runs as. Deliberately not the owner of anything.
--
-- Row-level security does not apply to a superuser, and by default does not
-- apply to a table's owner either. If the application connected as the owner,
-- every policy in this schema would be decorative. So the API runs as
-- `mfi_app`, which owns no objects and holds only the privileges granted to it
-- explicitly, table by table.
--
-- Created without LOGIN: credentials are provisioned out of band by whoever
-- operates the database, never committed to a repository. Sessions that connect
-- as a more privileged role adopt it with `SET LOCAL ROLE mfi_app`, which is
-- also how the isolation suite proves the policies work.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mfi_app') THEN
    CREATE ROLE mfi_app NOLOGIN NOBYPASSRLS;
  END IF;
END;
$$;

COMMENT ON ROLE mfi_app IS
  'Least-privilege application role. Owns nothing, so row-level security is always enforced against it.';

GRANT USAGE ON SCHEMA public TO mfi_app;

-- Explicitly revoke the ability to create objects in the schema: the
-- application reads and writes rows, it does not alter structure.
REVOKE CREATE ON SCHEMA public FROM mfi_app;

GRANT EXECUTE ON FUNCTION uuid_generate_v7() TO mfi_app;
