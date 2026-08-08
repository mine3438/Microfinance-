# MFI Manager

Microfinance management and Bank of Tanzania MSP2 regulatory reporting for
Tier II Microfinance Service Providers.

Tanzania's Tier II MSPs must file ten standardised quarterly forms
(MSP2-01 … MSP2-10) with the Bank of Tanzania. Done by hand in spreadsheets
that takes roughly three days per quarter. The bet this system makes: capture
daily lending operations in a schema that mirrors BOT's reporting categories,
and the quarterly filing becomes an export rather than a re-derivation.

## Status

Early construction. Stages 0–8 of 19 complete: repository foundation, tooling,
CI, migration infrastructure, the exact-decimal money layer, the tenancy core
with its cross-tenant isolation suite, the seeded BOT reference data, the
identity schema with password, token and permission primitives, audit logging,
the client context, the lending core with both interest engines, and the
approval workflow. No HTTP surface yet.

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
pnpm verify               # format, lint, typecheck, build, test
```

## Commands

| Command | Purpose |
|---|---|
| `pnpm verify` | The full gate CI runs: format, lint, typecheck, build, test |
| `pnpm lint` | ESLint, including the architectural boundary rules |
| `pnpm typecheck` | TypeScript across every package, tests included |
| `pnpm test` | All test suites |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:status` | List applied and pending migrations |
| `pnpm db:verify` | Fail if the repository and database disagree |
| `pnpm services:up` / `services:down` | Start or stop Postgres and Redis |

## Layout

```
apps/          API and web applications
packages/
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
- **BOT reference data is generated, never transcribed.** The 22 sectors, 193
  districts, provisioning bands and 103 financial-statement line items are
  extracted from BOT's own template and emitted as a migration by a committed
  script. Twenty-two sectors typed by hand would contain errors, and each one
  would surface as a wrong regulatory filing rather than as a crash.

## Licence

MIT — see [`LICENSE`](LICENSE).
