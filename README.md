# MFI Manager

Microfinance management and Bank of Tanzania MSP2 regulatory reporting for
Tier II Microfinance Service Providers.

Tanzania's Tier II MSPs must file ten standardised quarterly forms
(MSP2-01 … MSP2-10) with the Bank of Tanzania. Done by hand in spreadsheets
that takes roughly three days per quarter. The bet this system makes: capture
daily lending operations in a schema that mirrors BOT's reporting categories,
and the quarterly filing becomes an export rather than a re-derivation.

## Status

Early construction. Stages 0–10 of 19 complete, plus the API foundation:
repository foundation, tooling, CI, migration infrastructure, the exact-decimal
money layer, the tenancy core with its cross-tenant isolation suite, the seeded
BOT reference data, the identity schema with password, token and permission
primitives, audit logging, the client context, the lending core with both
interest engines, the approval workflow, payment allocation with reversals, and
overdue classification with provisioning and a freshness gate on reporting.

The HTTP surface has started: a Fastify API with the shared wire contract,
authentication, refresh-token rotation with reuse detection, and the security
controls around them. Resource routes for clients, loans and payments are next.

See [`docs/01-ARCHITECTURE.md`](docs/01-ARCHITECTURE.md) §16.4 for the full
stage plan.

## Documentation

| Document | What it covers |
|---|---|
| [`docs/00-PROJECT-ANALYSIS.md`](docs/00-PROJECT-ANALYSIS.md) | Feature summary, missing requirements, risk register, recommendations |
| [`docs/01-ARCHITECTURE.md`](docs/01-ARCHITECTURE.md) | System design, layering, financial correctness, security, stage plan |
| [`docs/02-BOT-REPORTING-SPEC.md`](docs/02-BOT-REPORTING-SPEC.md) | The ten MSP2 forms as read from BOT's own template — the authority on reporting |
| [`docs/reference/`](docs/reference/) | BOT template plus taxonomies extracted from it as seed data |

## Requirements

- Node.js 22+ (see `.nvmrc`)
- pnpm 10+
- PostgreSQL 16 and Redis 7 — via Docker Compose, or installed natively

Postgres is pinned to 16 because the financial and tenancy test suites assert
against its `NUMERIC` semantics and row-level security behaviour. A local
version that drifts from production makes those tests lie.

## Getting started

```bash
pnpm install
cp .env.example .env      # then fill it in; .env is never committed
pnpm services:up          # Docker Compose, or native services if no daemon
pnpm db:migrate
pnpm verify               # format, build, lint, typecheck, test
```

## Commands

| Command | Purpose |
|---|---|
| `pnpm verify` | The full gate CI runs: format, build, lint, typecheck, test |
| `pnpm lint` | ESLint, including the architectural boundary rules |
| `pnpm typecheck` | TypeScript across every package, tests included |
| `pnpm test` | All test suites |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:status` | List applied and pending migrations |
| `pnpm db:verify` | Fail if the repository and database disagree |
| `pnpm services:up` / `services:down` | Start or stop Postgres and Redis |

## Layout

```
apps/
  api/         Fastify HTTP interface: routes, guards, use cases
packages/
  contracts/   zod request and response schemas, shared by API and web
  money/       exact-decimal Money, Rate, Percentage value objects
  domain/      business rules and value objects; no framework, no I/O
  identity/    password hashing, session tokens, the permission model
  db/          Postgres access, tenant-scoped transactions, driver safety
  migrator/    forward-only, checksum-verified SQL migration runner
db/
  migrations/  versioned SQL, immutable once applied
scripts/       build and data-generation tooling
docs/          analysis, architecture, BOT specification, extracted reference data
```

Two Postgres schemas, and the split is structural rather than stylistic:
`public` holds institution data and every table in it must enforce row-level
security; `reference` holds BOT's own taxonomies — sectors, districts,
provisioning rates, form line items — which belong to no institution and are
granted read-only. "Is this tenant data?" is answered by where a table lives,
not by a list someone has to keep up to date.

Packages appear as their stage builds them, rather than as empty shells.

## Architectural rules, enforced not just documented

Dependencies point inward only: the domain declares interfaces, infrastructure
implements them, and the application depends on the interfaces. A convention
that lives only in a document decays, so each edge is an ESLint rule that fails
the build — a domain file importing a database driver, an HTTP framework, or
Node I/O does not merge.

Two more rules in the same spirit:

- **Interpolated SQL is a lint error.** Parameterised queries only. The
  handful of legitimate exceptions are identifier interpolation, each carrying
  a written justification at the site.
- **Applied migrations are immutable.** Checksums are recorded on apply and
  verified on every run, including in CI, so editing schema history fails
  loudly instead of silently diverging the database from the repository.
- **Money is never a float.** Amounts are exact decimals end to end —
  `NUMERIC(15,2)` at rest, strings on the wire, `Money` in code. Constructing
  an amount from a JavaScript number throws, and opening a database connection
  asserts the driver still returns `NUMERIC` as a string, since one
  `setTypeParser(1700, parseFloat)` anywhere in the process would silently turn
  every balance into a double.
- **No table without tenant isolation.** Every tenant-scoped table carries a
  `NOT NULL institution_id`, has row-level security enabled *and* forced, and
  is reachable only through policies that consult `current_institution_id()`.
  A schema-invariant suite reads the live catalogue on every commit, so a table
  added without those properties fails CI on the commit that adds it rather
  than in an incident months later.
- **Tenancy fails closed.** Forgetting the tenant context yields no rows, never
  all rows — and the application layer refuses the operation before it reaches
  the database, because an empty result is indistinguishable from an
  institution that has no data.
- **A payment is never edited.** Recorded payments are append-only: the
  application holds INSERT and SELECT and nothing else. Correcting a mis-keyed
  payment means recording a linked reversal that negates it exactly, so the
  mistake and its correction both stay visible. The system this replaces made
  payments immutable and never built the correction, so fixing one meant
  editing the database by hand — which destroys the property the immutability
  was protecting.
- **Money cannot be advanced on an application nobody sanctioned.** The status
  machine is enforced by a database trigger as well as in the domain, and the
  approver may not be the person who submitted — including an administrator
  holding every permission. A control the interface enforces is not a control,
  because the interface is not the only way in.
- **One schedule engine, not two.** The system it replaces computed a payment
  breakdown twice — once server-side to write the schedule, once in the browser
  to preview it — and its own technical document warned that if they drifted,
  the preview would lie about what was actually recorded. Here the preview
  endpoint and the write path call the same function; there is no second
  implementation to drift from.
- **Every change is audited, by the database.** One generic trigger is
  attached to every business table, and a test reads the catalogue to confirm
  none was missed — so a write path added later is audited whether or not
  anyone remembers. Entries are append-only: the application holds SELECT and
  nothing else, so an entry cannot be amended, removed, or forged. Password and
  token hashes are stripped before they are written, because an audit trail
  holding secrets is a second credential store with longer retention.
- **Authorisation is permissions, not role names.** Five seeded roles are
  named bundles of 29 permissions. A loan officer holds `loan.create` and not
  `loan.approve`, and the domain refuses an approval by the user who made the
  application — segregation of duties enforced where it cannot be bypassed,
  rather than in an interface that is not the only way in.
- **Stale figures cannot be filed.** Overdue classification is recomputed by a
  job that stamps a health record, and reporting refuses to generate when that
  record is missing or older than a day. The system this replaces scheduled the
  same job with a `pg_cron` line left commented out, so a loan forty days past
  due kept reporting "Current" — to the dashboard and to the Bank of Tanzania.
  Nothing crashed and no screen was empty; the numbers simply were not true.
  A compliance product that quietly files wrong figures is worse than one that
  refuses to file.
- **An unclassifiable loan is reported, not absorbed.** BOT's housing
  microfinance schedule begins at 91 days and defines nothing below it, so a
  housing loan 40 days overdue has no classification BOT has given. It is left
  unclassified and counted, and its presence blocks filing — rather than being
  rounded into "Current", which would understate provisions on a signed return.
- **The wire contract is one definition, not two.** Every request and response
  is a zod schema in `packages/contracts`; the API validates against it and the
  web client imports the same object, so a shape change is a compile error on
  both sides rather than a runtime surprise on one. Objects are strict — an
  unrecognised key is rejected, not stripped — because on a request that moves
  money, silence is the wrong answer to a typo.
- **Nothing is constructed except at the composition root.** There is no
  container and no runtime resolution: `composition.ts` builds every dependency
  and passes it inward as an argument, so a wiring mistake is a type error at
  the line that would have supplied it rather than an exception when a module
  loads. A lint rule keeps it that way, and was verified to fire.
- **An error discloses nothing by default.** One handler turns a thrown value
  into a response; anything not deliberately classified becomes a 500 with a
  fixed message and a correlation ID, while the real cause goes to the log. The
  system this replaces surfaced raw Postgres errors to the browser, which
  described the schema to an attacker and told the user nothing actionable.
- **A cache outage does not stop the institution.** The rate limiter continues
  unlimited when Redis is unreachable — its plugin default is to fail the
  request, which would return 500 for every call because a cache is down. Login
  alone fails closed, because there the limit *is* the control rather than a
  protection around one.
- **BOT reference data is generated, never transcribed.** The 22 sectors, 193
  districts, provisioning bands and 103 financial-statement line items are
  extracted from BOT's own template and emitted as a migration by a committed
  script. Twenty-two sectors typed by hand would contain errors, and each one
  would surface as a wrong regulatory filing rather than as a crash.

## Licence

MIT — see [`LICENSE`](LICENSE).
