# Migrations

Versioned, forward-only SQL applied by `@mfi/migrator`.

## Naming

`<version>_<name>.sql` — four or more digits, then lower snake_case:

```
0001_core_schema.sql
0002_reference_data.sql
```

Four digits rather than a timestamp because these are read in review: `0007`
against `0008` is legible at a glance where two 14-digit timestamps are not.

## Rules

1. **Applied migrations are immutable.** Checksums are recorded on apply and
   verified on every subsequent run. Editing a migration that has already run
   fails the next `migrate`, `status`, or `verify` — including in CI. To change
   something, write a new migration.
2. **No `down` migrations.** Rolling a schema backwards against live financial
   data loses information. The recovery path is a new forward migration,
   reviewed like any other change.
3. **One concern per migration**, so a failure is legible and a review is
   possible.
4. **Do not write `BEGIN`/`COMMIT`.** Each migration is already wrapped in its
   own transaction.
5. **Opting out of that transaction** requires a `-- mfi:no-transaction` marker
   on its own line, needed for statements Postgres refuses to run inside a
   transaction — `CREATE INDEX CONCURRENTLY`, `ALTER TYPE ... ADD VALUE`. Such
   a migration is not atomic: a mid-way failure leaves partial state to clean
   up by hand, so use it deliberately.

## Commands

```bash
pnpm db:migrate   # apply every pending migration
pnpm db:status    # list applied and pending
pnpm db:verify    # check repository against registry; fails if anything is pending
```
