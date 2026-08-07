# Architecture Design — MFI Manager

**Status:** Proposed. Awaiting approval. No implementation code written.
**Supersedes:** the stack described in TRD v1.0 §1–§4 (Supabase-native).
**Companion:** `00-PROJECT-ANALYSIS.md`

---

## 1. Decisions Taken

| Decision | Value | Source |
|---|---|---|
| Starting point | Greenfield build | Approved |
| Scope | Full enterprise brief | Approved |
| Accounting depth | Ledger **seam** designed, posting logic deferred until after first BOT filing | Approved (defer) + §3.3 below |
| Architecture | Option B — layered API over Postgres | Approved |

### 1.1 What "ledger seam, deferred" means concretely

Every financial event (disbursement, repayment, penalty accrual, fee,
write-off, savings deposit/withdrawal, share subscription, expense,
income) is emitted as a typed **domain event** carrying the amounts,
accounts, and direction a double-entry posting would need. In v1 those
events feed audit and reporting only. Adding a ledger later means writing
one subscriber that turns events into balanced journal lines — no changes
to any existing use case.

Cost of the seam now: small. Cost of retrofitting without it: every
financial use case gets reopened.

---

## 2. Departures From the Documented Stack

Recorded explicitly, because these override TRD v1.0.

| Area | TRD v1.0 | This design | Why |
|---|---|---|---|
| Backend | None — Supabase Edge Functions only | NestJS API (layered) | Full brief needs transactions, workflow, a permission model, and testable domain logic. Edge Functions are a poor home for any of it. |
| Auth | Supabase Auth + JWT claims hook | Self-hosted in API: argon2id, short-lived access JWT + rotating refresh tokens | Eliminates R4 (the manual dashboard hook whose absence silently empties the app). Also required for invitations and a permission model. |
| Tenancy | RLS only | App-layer tenant guard **primary**, RLS via `SET LOCAL` **secondary** | R6 — RLS was a single point of failure with nothing proving it held. |
| Money math | JS floats + `Math.round()`, duplicated frontend/backend | `Decimal` value object, single implementation in domain layer, `NUMERIC` at rest | R1 + R2. Frontend never computes money; it calls preview endpoints that run the same code the write path runs. |
| Transactions | Manual compensating delete | Explicit unit-of-work per use case | R3 |
| Roles | Hardcoded `admin` / `officer` | Permission-based roles (seeded system roles) | Approval workflow needs a distinct approver; multi-branch needs a branch manager (PRD §7 open question) |
| Report export | 100% client-side, never archived | Server-generated, archived, re-downloadable | R10 + §4.7 of the analysis — the archive of what was actually filed is a compliance asset |

Postgres remains the database. Supabase may still host it — this design
treats Supabase as *a managed Postgres*, not as the backend. That
preserves an exit path (R11).

---

## 3. System Topology

```
   ┌──────────────┐        ┌──────────────┐
   │  Web client  │        │   PWA shell  │
   │  React + TS  │        │  (installable)│
   └──────┬───────┘        └──────┬───────┘
          │  HTTPS / JSON, bearer access token
          ▼                       ▼
   ┌────────────────────────────────────────┐
   │            API  (NestJS)               │
   │  helmet · CORS · rate limit · zod DTO  │
   └───┬───────────┬───────────┬────────────┘
       │           │           │
       ▼           ▼           ▼
  ┌─────────┐ ┌────────┐ ┌───────────┐
  │Postgres │ │ Redis  │ │ S3-compat │
  │(primary)│ │(cache, │ │ (documents│
  │  RLS on │ │ limits,│ │  + report │
  │         │ │ revoke)│ │  archive) │
  └─────────┘ └────────┘ └───────────┘
       ▲
       │  outbound
  ┌────┴─────────────────────┐
  │ Email (transactional)    │
  │ SMS gateway (deferred)   │
  └──────────────────────────┘
```

**Deployment:** API as a container (Fly/Render/ECS — any). Web on a CDN
host. Postgres managed with PITR enabled. All secrets from environment,
never committed. No service-role-equivalent key ever reaches a client
bundle.

---

## 4. Layering and Dependency Rules

```
┌──────────────────────────────────────────────────────────┐
│ PRESENTATION      React. Renders state, collects input.  │
│                   Zero business logic. Zero money math.  │
├──────────────────────────────────────────────────────────┤
│ INTERFACE         Controllers, DTOs (zod), guards,       │
│  (api)            interceptors, mappers, rate limiting.  │
│                   Translates HTTP ⇄ use cases. No rules. │
├──────────────────────────────────────────────────────────┤
│ APPLICATION       Use cases, one per business operation. │
│                   Owns the transaction boundary.         │
│                   Orchestrates domain + ports.           │
├──────────────────────────────────────────────────────────┤
│ DOMAIN            Entities, aggregates, value objects,   │
│                   invariants, domain services, events,   │
│                   port interfaces. **Pure TypeScript.**  │
│                   Zero framework/ORM/HTTP imports.       │
├──────────────────────────────────────────────────────────┤
│ INFRASTRUCTURE    Repository implementations, migrations,│
│                   storage, email, PDF/XLSX renderers,    │
│                   clock, id generator, audit sink.       │
│                   Implements domain-declared ports.      │
└──────────────────────────────────────────────────────────┘
```

**The one rule:** dependencies point inward only. Domain declares
interfaces; infrastructure implements them; application depends on the
interfaces, never the implementations. Enforced mechanically by an ESLint
import-boundary rule in CI, not by discipline — the documented build
already shows what happens when a boundary is only a convention (UX Brief
§3: generic form primitives living in the auth feature folder).

**SOLID mapping, briefly:** one use case per operation (SRP); new loan
products and interest methods register as strategies rather than editing
a switch (OCP); interest methods are substitutable behind one interface
(LSP); ports are narrow and per-need rather than one god-repository
(ISP); application depends on abstractions only (DIP).

---

## 5. Repository Layout

```
mfi-manager/
├── apps/
│   ├── api/                    NestJS
│   │   └── src/
│   │       ├── modules/<ctx>/  interface + application per context
│   │       ├── common/         guards, filters, interceptors, pipes
│   │       └── main.ts
│   └── web/                    React + Vite
│       └── src/
│           ├── features/<ctx>/ pages, hooks, feature components
│           ├── shared/ui/      Badge, Skeleton, EmptyState, form
│           │                   primitives  ← relocated per UX Brief §3
│           ├── shared/lib/     api client, formatters, guards
│           └── app/            router, providers, boot health check
├── packages/
│   ├── domain/                 pure TS. entities, VOs, events, ports
│   ├── contracts/              zod schemas + inferred types,
│   │                           shared by api and web (single source
│   │                           of truth for every request/response)
│   ├── money/                  Money, Rate, Percentage value objects
│   └── config/                 tsconfig, eslint, prettier presets
├── db/
│   ├── migrations/             versioned, forward-only
│   └── seeds/                  system roles, BOT taxonomies
└── docs/
```

`packages/contracts` is what keeps the frontend honest: the web app
imports the same zod schemas the API validates against, so a shape change
is a compile error on both sides rather than a runtime surprise.

---

## 6. Bounded Contexts

| Context | Owns | Status |
|---|---|---|
| **identity** | institutions, branches, users, roles, permissions, invitations, sessions, password reset | v1 |
| **client** | clients, KYC fields, guarantors, client documents | v1 |
| **group** | lending groups, membership, joint-liability policy | v1 — rules needed (§13) |
| **lending** | loan products, applications, approval workflow, disbursement, schedules, interest, penalties, restructuring, write-off | v1 — rules needed (§13) |
| **repayment** | payments, allocation, reversals, receipts | v1 |
| **savings** | savings products, accounts, transactions, interest accrual | v1 — rules needed (§13) |
| **shares** | share accounts, subscriptions, transfers, dividends | v1 — rules needed (§13) |
| **finops** | expenses, income, bank accounts (quarter balances) | v1 |
| **compliance** | BOT MSP2 compilation, report archive, submission log | v1 |
| **support** | complaints | v1 |
| **documents** | uploads, attachment linkage, signed access | v1 |
| **notification** | in-app notifications, email; SMS behind a port | v1 (SMS adapter deferred) |
| **audit** | audit log write + query | v1 |
| **analytics** | dashboard aggregates | v1 |
| **ledger** | chart of accounts, journals | **deferred** — event seam only |

Contexts communicate through application services and domain events, not
by reaching into each other's repositories.

---

## 7. Financial Correctness

This section is the reason the project exists. Everything here is
non-negotiable.

### 7.1 Money representation

- **At rest:** `NUMERIC(15,2)`. Exact decimal. Never `float`/`double`.
- **In transit:** JSON **strings**, never JSON numbers — a JSON number is
  a double the moment any parser touches it.
- **In code:** a `Money` value object wrapping `decimal.js`. Immutable.
  Carries currency. Arithmetic only through its methods.
- **Driver config:** the Postgres driver's `NUMERIC` parser is overridden
  to return strings, not JS numbers. This is a one-line change that
  prevents an entire class of silent precision loss, and it is asserted
  by a test so nobody removes it.
- **Lint rule:** arithmetic operators applied to any `Money`-typed value
  are a build error. You cannot accidentally write `a + b` on money.

`Rate` and `Percentage` are separate value objects. A monthly rate stored
as `0.05` and a percentage `5` are different types and cannot be mixed —
this is the most common source of a 100× error in lending software.

### 7.2 One implementation, no preview drift

R2 is retired structurally. The frontend **never** computes money.
Instead:

```
POST /loans/preview     → runs the same domain code as POST /loans
POST /payments/preview  → runs the same allocation code as POST /payments
```

Preview endpoints are read-only, side-effect-free, and call the identical
domain service the write path calls. A preview cannot disagree with the
booked result, because there is only one implementation. The UX Brief's
live-calculation pattern (§4) is preserved exactly — it just gets its
numbers from the authority instead of from a copy.

### 7.3 Interest

Two methods from the documentation, behind one `InterestMethod` port so
a third is additive:

- **Flat:** `interest = principal × monthlyRate`, constant per period.
- **Reducing balance:** `interest = openingBalance × monthlyRate`, with
  the level payment from the standard amortisation formula.

**Rounding:** half-up to 2dp, applied per period. The terminal period
force-closes any residual so the schedule sums exactly to principal —
preserved from TRD §5, but now over exact decimals, so the force-close
corrects a rounding remainder rather than masking float drift.

**Verification:** golden test vectors — fixed inputs, hand-checked
expected schedules — committed as fixtures. Plus property tests: for any
valid input, `Σ principal_due == principal` exactly, and every amount has
at most 2 decimal places.

### 7.4 Payment allocation

Documented order is interest-then-principal. With penalties added, the
order becomes **penalties → fees → interest → principal**, which is the
standard and matches the analysis in §2.3. *This ordering is a business
rule requiring your confirmation (§13.2).*

Invariants enforced in the domain:
- allocation components sum exactly to amount paid;
- `balance_after = balance_before − principal_allocated`, exactly;
- no component is negative;
- allocation never exceeds outstanding.

The server always refetches true balance inside the transaction and never
trusts a client-submitted balance — preserved from TRD §4.

### 7.5 Reversals, not mutations

Payments stay append-only and immutable, as designed. The missing piece
from the documented build is added: a **reversal** is a new linked
payment row with negated allocation, an actor, a reason, and a timestamp.
The original is never edited or deleted. Balances and schedule paid-flags
recompute from the payment set. This closes R9 without weakening the
audit property that motivated immutability.

### 7.6 Sequence integrity

`client_code` / `loan_code` keep the documented `MFI-{year}-{seq}` and
`LN-{year}-{seq}` formats, but are allocated from a
`code_sequences(institution_id, entity, year, next_value)` row locked
`FOR UPDATE` inside the same transaction as the insert. Retires R7 — the
`SPLIT_PART`-on-max race — while keeping the format users will see.

---

## 8. Data Model

### 8.1 Preserved from the documented schema

`institutions`, `users`, `clients`, `loans`, `repayment_schedules`,
`payments`, `expenses`, `complaints`, `audit_logs`, `bot_reports` —
with their documented columns, constraints, and BOT-aligned enumerations
(5-tier overdue classification, 12 loan types, sector taxonomy, 6
complaint categories, `male`/`female` gender per BOT's form constraint).

### 8.2 Added

| Table | Purpose | Closes |
|---|---|---|
| `branches` | Multi-branch. FK on users, clients, loans, savings, payments | Brief |
| `roles`, `permissions`, `role_permissions`, `user_roles` | Permission model | Brief + approval workflow |
| `invitations` | Officer/staff invitation flow | PRD §4.2 gap, analysis §4.8 |
| `refresh_tokens` | Rotating refresh tokens, revocation | Self-hosted auth |
| `loan_products` | Rate, method, term bounds, fees, **penalty config**, approval thresholds | Brief |
| `loan_applications`, `loan_approvals` | Maker-checker workflow | Brief |
| `loan_penalties` | Penalty accrual entries per loan | Brief |
| `payment_reversals` | Linked reversing entries | R9 |
| `guarantors` | Guarantor records + loan linkage | Brief |
| `groups`, `group_members`, `group_loans` | Group lending | Brief |
| `savings_products`, `savings_accounts`, `savings_transactions` | Savings | Brief |
| `share_products`, `share_accounts`, `share_transactions` | Shares | Brief |
| `bank_accounts` | Per-quarter bank/MNO balance snapshots | **MSP2-07, and de-stubs MSP2-01/05** |
| `documents` | Uploads + polymorphic attachment | Brief |
| `notifications`, `notification_deliveries` | In-app + channel delivery log | Brief |
| `domain_events` | Ledger seam (§1.1) | Deferred ledger |
| `code_sequences` | Race-free code allocation | R7 |
| `system_health` | Classification freshness timestamp | R5 |

### 8.3 Integrity rules

- Every business table carries `institution_id NOT NULL` (indexed) and,
  where branch-scoped, `branch_id`.
- Foreign keys everywhere. `ON DELETE RESTRICT` on all financial
  references — a client with loans, or a loan with payments, cannot be
  deleted. Financial entities are never hard-deleted; status columns
  only.
- **Every BOT-feeding enumeration becomes a DB CHECK constraint or a
  lookup-table FK** — including expense/income categories, client sector,
  and loan type, all of which were client-side-only in the documented
  build (R12). A field that feeds a regulatory filing does not get to be
  validated only in a browser.
- All money columns `NUMERIC(15,2)`; rates `NUMERIC(6,4)`.
- All timestamps `TIMESTAMPTZ`. `Africa/Dar_es_Salaam` applied only at
  the presentation edge.
- Indexes derived per access path, not sprinkled: tenant+status+date
  composites for every list screen, plus the quarter/year ranges the BOT
  compiler scans.
- Migrations versioned, forward-only, reviewed, applied in CI against a
  throwaway database before merge.

---

## 9. Multi-Tenancy, Identity, Authorization

### 9.1 Tenancy — defence in depth

1. **Primary:** every repository method takes a `TenantContext`
   (institution + optional branch) resolved from the authenticated
   principal. A base repository injects the predicate. A repository
   method that can be called without tenant scope does not compile.
2. **Secondary:** each transaction opens with
   `SET LOCAL app.institution_id = $1`, and RLS policies read
   `current_setting('app.institution_id', true)`. If the app layer is
   ever bypassed or buggy, the database still refuses.
3. **Proof:** an automated isolation suite asserts, for every table, that
   institution A cannot read or write institution B's rows through every
   exposed route. Runs on every commit. R6 stops being an untested
   assumption.

### 9.2 Roles and permissions

The documented two-role model cannot express an approver distinct from a
maker, or a branch-scoped manager. Replaced with permissions
(`loan.create`, `loan.approve`, `loan.disburse`, `payment.reverse`,
`report.generate`, `settings.manage`, `user.invite`, …) bundled into
seeded system roles:

| Role | Scope | Notes |
|---|---|---|
| `institution_admin` | institution | full |
| `branch_manager` | branch | approves within threshold — answers PRD §7's open question |
| `loan_officer` | branch | create client/loan/payment; no approve, no reverse |
| `accountant` | institution | finops, reports; no lending writes |
| `auditor` | institution | read-only everywhere, including audit log |

Custom roles are possible but not required for v1.

**Segregation of duties:** the domain refuses an approval by the same
user who created the application. This is an invariant in the aggregate,
not a UI check.

### 9.3 Authentication

argon2id password hashing. Access JWT ~15 min, refresh token rotating
with reuse detection (a replayed refresh token revokes the family).
Refresh tokens stored hashed. Email verification and password reset are
single-use, expiring, hashed tokens — and unlike the documented build,
**resend-verification exists** as its own operation, distinct from
password reset (App Flow §2 gap).

Route guards on the API are the real boundary. The frontend additionally
gets **route-level** role guards so an officer hitting `/settings` sees a
clean 403 rather than the documented build's degraded half-rendered page
(App Flow §1).

---

## 10. Cross-Cutting Concerns

### 10.1 Transactions

One transaction per use case, opened by the application layer, passed
down as a unit-of-work. Loan creation writes application + loan +
schedule + events atomically or writes nothing. R3 is retired — there are
no compensating deletes anywhere in this design.

Concurrency: optimistic locking (`version` column) on loans and savings
accounts, so two officers recording payments simultaneously cannot
interleave into a wrong balance.

### 10.2 Audit

Two layers, deliberately redundant:
- **Application:** an interceptor records actor, use case, target, and
  outcome for every state-changing operation.
- **Database:** one generic `audit_row_change()` trigger attached to
  every business table, capturing before/after JSONB.

The DB layer is what makes this survivable: a new write path added in six
months is audited whether or not the developer remembers. This is exactly
how the documented build's audit table ended up decorative (R8).

Audit rows are append-only and readable by `auditor` and
`institution_admin`. Retention is a business rule (§13.6).

### 10.3 Classification freshness — R5

`update_overdue_classifications` runs as a scheduled job **inside the
API** (not `pg_cron`, so it cannot be silently left commented out), and
writes `system_health.classifications_updated_at` on every successful
run. If that timestamp is older than 24h:

- every overdue badge in the UI renders a staleness marker;
- **BOT report generation is blocked** with an explicit reason.

A compliance product that quietly files "Current" on a 40-day-overdue
loan is worse than one that refuses to file. This turns the worst bug
class in the product into a visible, blocking, self-explaining failure.

### 10.4 Boot health check — R4

On startup the API asserts: database reachable, migrations at expected
version, tenant isolation function present, scheduler registered. On
failure it refuses to serve rather than serving empty results. The web
app surfaces a hard banner on API health failure instead of rendering an
empty dashboard.

### 10.5 Security controls

| Control | Implementation |
|---|---|
| Input validation | zod at every boundary; unknown keys stripped; typed DTOs from `packages/contracts` |
| SQL injection | Parameterised queries only; no string-concatenated SQL; lint rule bans raw interpolation |
| XSS | React escaping by default; no `dangerouslySetInnerHTML`; strict CSP with nonces |
| CSRF | Bearer tokens in `Authorization` headers, not ambient cookies — classic CSRF does not apply. If refresh tokens use cookies, they are `HttpOnly`, `Secure`, `SameSite=Strict`, with double-submit on refresh only. *Documented as a decision, not left implicit (analysis §2.1).* |
| Rate limiting | Redis-backed, per-IP and per-user; strict tiers on login, password reset, invitation, and report generation |
| File uploads | Extension **and** MIME **and** magic-byte sniffing; size caps; randomised stored names; served only via short-lived signed URLs; never executed; stored outside the web root |
| Secrets | Environment only; startup fails on missing required vars; no key with RLS-bypass power ever in a client bundle |
| Transport | HTTPS only, HSTS, helmet defaults |
| Errors | No stack traces or SQL to clients; correlation ID returned for support |
| Dependencies | Lockfile committed, audit + SCA in CI |

### 10.6 Performance

Keyset (cursor) pagination on every list — offset pagination degrades
exactly where a growing loan book hurts most. Indexes per access path.
Redis caching for dashboard aggregates and BOT pre-aggregations with
explicit invalidation on the mutations that affect them. Repositories
return fully-formed aggregates, so N+1 is not expressible. React Query on
the client with per-query stale times, plus route-level code splitting
and lazy loading — the frontend patterns from the documented build were
sound and are preserved.

The documented build's mutation-invalidation fragility (TRD §2 — "every
mutation must be manually audited") is reduced by centralising query keys
in one typed registry per context, so an invalidation set is a named
export rather than five hand-written strings at each call site.

### 10.7 Observability

Structured JSON logs with correlation IDs, never containing PII or full
account numbers. Health/readiness endpoints. Error tracking. Metrics on
the operations that matter: loan creation, payment recording, report
compilation duration (PRD §5 proposes a sub-30-second compilation
target — this makes it measurable rather than aspirational).

---

## 11. BOT Compliance Reporting

The product thesis. Treated accordingly.

- **All 10 MSP2 forms.** `bank_accounts` (§8.2) supplies MSP2-07 and
  de-stubs the cash/bank fields in MSP2-01 and MSP2-05. MSP2-10 is a
  geographic aggregation over `clients.district`/`region` plus the new
  branch dimension. **MSP2-08 (Agent Banking) remains open** — the
  Implementation Plan says do not build it speculatively, and §13.7 asks
  you to confirm before I model it.
- **Compilation is server-side**, in a dedicated compliance module, from
  the operational tables. Generated XLSX is written to storage,
  registered in `bot_reports` (the table the documented build defined and
  never wrote to), and re-downloadable. You get an immutable record of
  what was actually filed.
- **PDF export** alongside XLSX, per your brief.
- **Pre-flight validation** before generation: missing MSP code, stale
  classifications (§10.3), zero-valued forms where source data exists
  elsewhere. The App Flow §3 problem — an institution that never touches
  `/more` generating a report with silently zero expenses and complaints
  while everything looks complete — becomes an explicit warning instead
  of a silent omission.
- Report generation is permissioned, rate-limited, and audited.

---

## 12. Testing and CI

| Layer | Tests |
|---|---|
| Domain | Unit. Golden financial vectors, property tests on schedule and allocation invariants. Highest coverage bar in the codebase. |
| Application | Integration against a real Postgres in a container — including rollback assertions |
| Tenancy | **Isolation suite**: cross-tenant access denial for every table via every route |
| Security | authz matrix per role × route; upload rejection cases; rate-limit behaviour |
| API | Contract tests against `packages/contracts` |
| Web | Component tests; E2E on the five core flows (signup → client → loan → payment → BOT report) |

**CI on every push:** typecheck (`tsc --noEmit`, strict) → lint incl.
import-boundary and money-arithmetic rules → migrations applied to a
throwaway DB → all suites → build. Red CI blocks merge.

This is also the structural answer to R14, the rebuild loop the
Implementation Plan diagnoses: "is it broken?" becomes a question with an
automatic answer instead of a judgement call made while frustrated.

---

## 13. Business Rules I Need From You

I will not invent these. Where I have a recommended default, it is stated
— confirming the default is enough to unblock; these are not open-ended
questions.

**13.1 Penalties.** Recommended shape, configured per loan product:
penalty rate, basis = *overdue installment amount* (alternatives:
outstanding principal, or total outstanding), grace period in days,
accrual = *daily, simple, non-compounding*, and an optional cap as a
percentage of principal. Confirm the shape and give me the default
values, or correct it.

**13.2 Allocation order.** Recommended: penalties → fees → interest →
principal. The documented build is interest → principal with no penalty
concept. Confirm.

**13.3 Approval workflow.** Recommended: `draft → pending_approval →
approved | rejected → disbursed → active → completed | written_off`, with
approval by a different user holding `loan.approve`, and amount
thresholds per role. I need the threshold values, and whether rejection
is terminal or returns to draft.

**13.4 Savings.** Interest rate basis and accrual frequency, minimum
balance, withdrawal rules/limits, whether savings can secure a loan.

**13.5 Shares.** Par value, subscription rules, transferability,
dividend declaration process, and whether shares are withdrawable.

**13.6 Group lending.** Joint liability model (fully joint vs. several),
whether group loans disburse to the group or to members individually,
group guarantee rules, and default handling.

**13.7 MSP2-08 Agent Banking.** Does any target institution actually use
agent banking? The Implementation Plan explicitly says don't build this
speculatively. Yes/no determines whether it's 10 forms or 9 + a
documented, PRD-updated exclusion.

**13.8 Also needed:** loan fees (types, when charged, refundable?),
whether 0% loans must be representable (the documented schema's
`CHECK monthly_rate > 0` forbids them), early-settlement/prepayment
rules, overpayment handling, restructuring rules, whether written-off
loans can receive recoveries, and audit/report retention periods.

Everything in §1–§12 can be built while these are outstanding. Only the
specific modules they govern are blocked.

---

## 14. Implementation Sequence

Each stage ends with: tests run, build verified, and a written summary of
what changed.

| # | Stage | Depends on |
|---|---|---|
| 0 | Monorepo, TS strict, lint + import boundaries, CI, migration tooling, Docker Postgres/Redis | — |
| 1 | `packages/money` — Money/Rate/Percentage, golden vectors, driver numeric-parser assertion | 0 |
| 2 | Core schema + migrations + RLS + **isolation suite green before any UI** | 0 |
| 3 | identity: auth, permissions, invitations, branches, session security | 1,2 |
| 4 | Audit (both layers) + domain-event seam + boot health check | 3 |
| 5 | client context: clients, KYC, guarantors, documents | 3,4 |
| 6 | lending core: products, interest engines, schedule generation, **preview endpoints** | 1,5 |
| 7 | lending workflow: applications, approval, disbursement | 6, §13.3 |
| 8 | repayment: allocation, reversals, receipts | 6, §13.2 |
| 9 | Penalties + scheduled classification job + freshness gating | 8, §13.1 |
| 10 | finops: expenses, income, bank accounts | 5 |
| 11 | compliance: all MSP2 forms, server-side XLSX + PDF, archive, pre-flight validation | 8,10 |
| 12 | support (complaints), notifications | 4 |
| 13 | savings | 5, §13.4 |
| 14 | shares | 5, §13.5 |
| 15 | groups + group lending | 6, §13.6 |
| 16 | Dashboard, analytics, search/filter, exports | 8,11 |
| 17 | Backup/restore, institution settings, hardening pass, load test | all |

Stages 1, 2, and 6 are the ones that must be right. Everything else is
recoverable; those three are the foundation the money sits on.

---

## 15. Approval Requested

Approve §1–§12 (or mark specific sections for change), and answer §13 —
at minimum 13.1, 13.2, and 13.3, which gate the lending core.

On approval I begin at Stage 0 and implement one stage at a time.
