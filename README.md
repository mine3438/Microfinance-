# MFI Manager

Microfinance management and Bank of Tanzania MSP2 regulatory reporting for
Tier II Microfinance Service Providers.

Tanzania's Tier II MSPs must file ten standardised quarterly forms
(MSP2-01 … MSP2-10) with the Bank of Tanzania. Done by hand in spreadsheets
that takes roughly three days per quarter. The bet this system makes: capture
daily lending operations in a schema that mirrors BOT's reporting categories,
and the quarterly filing becomes an export rather than a re-derivation.

## Status

Early construction. Stages 0–1 of 19 complete: repository foundation, tooling,
CI, database migration infrastructure, and the exact-decimal money layer. No
application features yet.

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
  migrator/    forward-only, checksum-verified SQL migration runner
db/
  migrations/  versioned SQL, immutable once applied
  seeds/       reference data
docs/          analysis, architecture, BOT specification
```

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
  an amount from a JavaScript number throws, and a test asserts the Postgres
  driver still returns `NUMERIC` as a string, since a driver reconfigured to
  parse it with `parseFloat` would silently turn every balance into a double.

## Licence

MIT — see [`LICENSE`](LICENSE).
