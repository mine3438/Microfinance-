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

---

## 16. Amendments — BOT Template (supersedes §13.7 and §14)

The official BOT template arrived after §1–§15 were written. See
`02-BOT-REPORTING-SPEC.md` for the full analysis. §1–§12 stand
unchanged; the amendments below extend them.

### 16.1 Decisions recorded

| Decision | Value |
|---|---|
| MSP2-01 / MSP2-02 production | **Option 1** — structured quarterly financial-statement entry, with all loan-derived lines auto-populated and locked. No general ledger in v1; ledger seam retained so entered figures become opening balances later |
| Monthly → annual rate conversion | **Configurable reference data, simple convention (`m × 12 × 100`) as default.** To be verified against a previously accepted filing or a BOT contact before first submission. The convention is a config value, not a constant in code, so correcting it is a data change |
| MSP2-08 Agent Banking | **In scope.** The template shows a single balance column per bank, not the agent transaction table previously assumed. §13.7 is closed |

### 16.2 Architecture changes

1. **`provisioning` domain service** — BOT's classification bands and
   provision rates as *versioned reference data with effective dates*
   (BOT can revise them), dual schedules for standard vs. housing
   microfinance, net-of-collateral computation, NPL ratio. Classification
   becomes **loan-type dependent**, not a single function.
2. **`branches` is mandatory**, not optional — MSP2-10 reports branch and
   employee counts per district. Staff carry a branch assignment; branches
   carry a district.
3. **Geography as seeded reference tables** — 31 regions, 193 districts,
   Mainland/Zanzibar, council-type suffixes preserved. Client and branch
   location become FKs, replacing free-text `district`/`region`.
4. **`financial_statement_lines`** — quarterly, Sno-keyed, per form,
   distinguishing auto-derived (locked) from entered (editable) lines.
5. **`bank_accounts`** — institution type (bank / MSP / MNO / foreign
   bank), seeded institution lists, TZS **and foreign-currency-equivalent**
   columns, quarter-end snapshots, plus a separate agent-banking balance
   for MSP2-08. Foreign-currency holdings need a rate and rate date
   (§11.6 of the BOT spec).
6. **Complaints extended** — monetary value, one of six nature
   categories, resolution route (institution vs. other party), referral
   destination, and quarterly roll-forward derivation.
7. **Compulsory savings** surfaced to MSP2-01, MSP2-03 (as a provision
   deduction) and MSP2-10. Its source of truth must be unambiguous
   (§11.7 of the BOT spec).
8. **Rate reporting** — annual-percent conversion per 16.1, min/max per
   loan type, split by amortisation method. `interest_method` becomes a
   first-class reporting dimension.
9. **Cross-form validation engine** — all 18 rules from
   `bot-taxonomies.json` run as pre-submission checks and **block export
   on failure**. Together with the freshness gate (§10.3), the system
   refuses to file a report it can tell is wrong.
10. **Sno-addressed cell mapping** — the exporter writes by
    (form, Sno, column), never hardcoded row index. BOT's own validation
    rules are expressed in Sno terms, and a template revision then
    becomes a data change rather than a code change.

### 16.3 Testing gain

Every formula in every form is now reproducible as a fixture. The
compliance module can be verified against BOT's actual arithmetic before
a real filing, which retires most of R10 — not by guessing better, but by
having the answer key.

### 16.4 Revised implementation sequence (supersedes §14)

| # | Stage | Depends on | Blocked by |
|---|---|---|---|
| 0 | Monorepo, TS strict, lint + import boundaries, CI, migrations, Docker Postgres/Redis | — | — |
| 1 | `packages/money` — Money/Rate/Percentage, golden vectors, driver numeric-parser assertion | 0 | — |
| 2 | Core schema + RLS + **isolation suite green before any UI** | 0 | — |
| 3 | Seed reference data: geography, sectors, loan types, banks/MNOs, provisioning schedules, BOT line items | 2 | — |
| 4 | identity: auth, permissions, invitations, **branches**, session security | 1,2 | — |
| 5 | Audit: generic trigger on every business table, tamper-proof log | 4 | — |
| 6 | client context: clients, guarantors (documents → API stage) | 4,5 | — |
| 7 | lending core: products, interest engines, schedules, **preview endpoints** | 1,6 | — |
| 8 | lending workflow: applications, approval, disbursement, **domain-event seam** | 7 | §13.3 |
| 9 | repayment: allocation, reversals, receipts | 7 | §13.2 |
| 10 | **provisioning + classification** (dual schedules) + scheduled job + freshness gating | 9 | §13.1 (penalties only) |
| 11 | finops: expenses/income mapped to BOT lines, bank accounts, agent banking | 6 | — |
| 12 | **financial statements**: quarterly entry, locked derived lines | 10,11 | — |
| 13 | compliance: all 10 forms, validation engine, XLSX + PDF, archive | 9,12 | — |
| 14 | support (complaints, roll-forward), notifications | 5 | — |
| 15 | savings incl. compulsory savings | 6 | §13.4 |
| 16 | shares | 6 | §13.5 |
| 17 | groups + group lending | 7 | §13.6 |
| 18 | Dashboard, analytics, search/filter, exports | 9,13 | — |
| 19 | Backup/restore, settings, hardening, load test | all | — |

**Amendment (stage 5).** The domain-event seam moves from stage 5 to stage 8.
Creating the table before any financial event exists would leave it empty in
every deployment — the exact fault the analysis records as R8 for `audit_logs`
and App Flow §4 for `bot_reports`, both of which were schema for capabilities
that were designed and never built. The seam lands with the first events it
carries. Audit itself ships in stage 5 fully wired, so it is populated from the
moment it exists. The boot health check listed here shipped early, in stage 2,
as `Database.verifyReadiness()`.

**Stages 0–7 are unblocked** by the outstanding §13 business rules and
can proceed immediately. Stages 1, 2, 7, and 10 are the ones that must be
right — they are where the money and the regulatory numbers live.

---

## 17. Amendments — API Stage (supersedes §2 and §5 on the HTTP framework)

### 17.1 Fastify replaces NestJS

§2 recorded NestJS as the API framework and §5 laid out its module tree. That
choice was made before the packages existed. Ten stages in, its cost is
measurable rather than hypothetical, so it is revised here with the reasoning
on the record.

NestJS resolves dependencies at runtime by reading the `design:paramtypes`
metadata TypeScript emits under `emitDecoratorMetadata`. That has three
consequences for this repository specifically:

1. **It is incompatible with `verbatimModuleSyntax`.** Under that flag a
   `import type` is erased exactly as written, so a constructor parameter typed
   by a type-only import has no metadata for the container to read and
   injection fails — at runtime, on the request path, not at compile time.
2. **`apps/api` would need its own relaxed `tsconfig`.** Turning
   `verbatimModuleSyntax` off and `experimentalDecorators` on makes the layer
   that handles every request the least strictly typed layer in the codebase.
3. **Wiring errors move from compile time to runtime.** A missing provider is a
   resolution exception when the module loads, not a type error where the
   mistake is.

Fastify with an explicit composition root avoids all three. There are no
decorators, so nothing is emitted and nothing is reflected; `apps/api` keeps
every compiler setting the other packages have held since stage 0. Dependencies
are constructed in one file and passed as arguments, which means the
inward-only rule of §4 is checked by the type system at the point of wiring —
the same property the ESLint boundary rules give the package graph, extended to
the object graph.

**What is given up:** guards, interceptors, exception filters and validation
pipes are conventions in NestJS and code here — roughly four hundred lines,
written and tested rather than inherited. That is the honest cost. It buys a
request path where a wiring mistake cannot reach production, on a system where
the request path moves money.

**What is unchanged:** every architectural rule in §4, §9 and §10. Layering,
the tenant guard, the transaction boundary, permission checks, audit and the
security controls of §10.5 are requirements on the API, not on the framework
underneath it. Fastify's plugin surface covers §10.5 directly — `@fastify/helmet`
for transport headers, `@fastify/rate-limit` backed by Redis for the tiers,
`@fastify/cookie` for the refresh cookie, `@fastify/multipart` for uploads.

### 17.2 Authentication needs a narrow RLS exemption

Every authenticated request carries its institution in the access token, so the
tenant setting is established before any query runs. Four operations have no
institution yet, because identifying one is the operation: **login**, **refresh**,
**invitation acceptance**, and **password reset**.

The application role is subject to row-level security, so an unscoped lookup
returns nothing — correctly, and uselessly. The alternative of asking the client
which institution it is logging into was rejected: it puts tenancy in the hands
of the caller, and an enumerable institution identifier on an unauthenticated
endpoint is a disclosure with no compensating benefit.

Instead a dedicated `auth` schema holds `SECURITY DEFINER` lookup functions
owned by a role with no table privileges beyond the columns each function
returns. The pattern matches `mfi_classifier` from stage 10: the exemption is
one named function with a fixed result shape, not a role that can read the
table. `users_email_unique` is global across institutions, so an email
identifies at most one user and no ambiguity arises.

Each function returns the minimum the operation needs and nothing decorative —
a login lookup returns the hash to verify against, the status to check, and the
institution to scope the rest of the request to. What it deliberately does not
do is reveal whether the email existed: that judgement belongs to the use case,
which answers identically either way.

### 17.3 New open question — §13.9 reopening a completed loan

Surfaced while building the payment routes, and not answerable from the
supplied documentation.

A loan reaches `completed` when a payment brings its balance to zero.
`completed` is terminal: nothing follows it in the domain's transition table or
in the `enforce_loan_transition` trigger, both from stage 8.

Reversing the payment that settled a loan therefore has no defined outcome. It
is not a hypothetical — a settlement cheque that does not clear, or a payment
keyed against the wrong loan and noticed the next morning, produces exactly this
case. Three things would need answering together:

1. May a completed loan return to `active`, and who may do it?
2. What happens if the loan was already reported as closed on a filed MSP2
   return — is the correction restated in the current quarter, or does the
   filing stand?
3. Does reopening restore the original schedule, or does the loan need a new
   one from the date it reopened?

Until those are answered, `reversePayment` refuses with a message naming the
situation. The two alternatives were both worse: inventing a `completed →
active` transition would contradict a rule already written and tested, and
letting the database trigger reject it produces an error that explains nothing
to the person holding the bounced cheque.

---

## 18. Amendments — BOT Reporting Stage

### 18.1 Reports restate the past; they do not read the present

The reporting repository reads neither `loans.outstanding_balance` nor
`loans.overdue_class`. Both describe the book *today*, and a return filed on 15
April for the quarter ending 31 March must describe it as it stood on 31 March.
Fifteen days of ageing move loans between classification buckets, and a payment
received on 2 April reduces a balance BOT wants reported unreduced.

Both figures are reconstructed instead:

- **Outstanding** is `payments.balance_after` from the latest payment dated on
  or before the period end, or the principal where there is none.
- **Days overdue** compares the schedule's cumulative amount due by each date
  against payments received by that date. `loan_days_overdue()` cannot be used
  here: it reads `repayment_schedules.is_paid`, which is current state, so an
  instalment due in March and settled in April would show as paid when asked
  about March.

This works only because payments are append-only and carry their own balance
snapshots — a stage 9 decision made for reconciliation that turns out to be
what makes restatement possible at all. No new tables were needed.

The figure reported as outstanding is **principal outstanding**, gross of
provisions, which is what §5 of the BOT specification ties to MSP2-01's
`Sno17 + Sno22`. Allocation is interest-first, so a payment smaller than the
interest owed moves no reported figure.

### 18.2 `branches.district_code` — a gap in stage 2, closed by migration 0013

02-BOT-REPORTING-SPEC.md §8 and §12.2 require a branch→district mapping;
`branches` carried employee assignment and not location. Without it a branch's
district could only be inferred from where its clients live, which counts one
Arusha branch once per district it lends into.

The column is nullable, because no migration can invent a district for a branch
that already exists, and a fabricated figure on a regulatory return is worse
than an absent one. `NULL` means "not yet located", and the readiness gate
refuses to compile while any **active** branch is in that state — the same
treatment an unclassifiable loan already receives.

### 18.3 The readiness gate gained a third problem

`assessReportingReadiness` now reports `unlocated_branches` alongside
`never_classified`, `classifications_stale` and `unclassifiable_loans`. The
refusal is a 422 whose details name each problem and what to do about it,
rather than a single message — an operator needs the whole list, because
one filing window per mistake is not a workable pace.

### 18.4 Four forms of ten, and the other six are named

`GET /reports/msp2/:year/:quarter` compiles MSP2-03, -04, -09 and -10, runs
BOT's cross-form validation rules over them, and returns the six it cannot
produce with the reason for each. The four rules that tie a portfolio form to
MSP2-01 or MSP2-02 are reported as warnings naming what is missing rather than
skipped in silence: a validator that reports "no problems" while omitting half
its rules is worse than one that reports none, because it is believed.

`annualisation` is a query parameter (`simple` by default) and the convention
applied is echoed on the compiled form, because §11.2 does not settle whether
BOT reads a monthly rate as simple or compounded.

### 18.5 Reference order is form layout

Sectors and loan types are read `ORDER BY sno`, districts by their region's
and their own `sort_order`. Every MSP2 form has a fixed number of rows in a
fixed order and BOT's EDI validator reads them by position, so ordering by code
would file every figure one row out.

### 18.6 The reports screen renders refusals as a first-class outcome

`/reports` is guarded on `report.generate`, which in the seeded catalogue is
held by the accountant and the institution administrator — a loan officer sees
no nav entry and the route refuses regardless.

The screen is built around a property that is easy to design away: this report
refuses more often than it succeeds, and the refusals are the product. A 422
carries one detail per readiness problem, and each is rendered as its own list
item with the remedy stated. Collapsing them into one line would leave an
operator fixing one problem per filing window.

Nothing partial is shown beside a refusal — no tables, no totals — because
figures rendered next to "this cannot be filed" get copied out of the screen.

Three display decisions, all recorded rather than assumed:

- **Empty rows are kept.** BOT reads its templates by position, so a sector
  with no lending is a row of zeros. Hiding it would show the operator a
  different document from the one being filed.
- **MSP2-10 opens on districts in use**, with a control to show all 193. The
  filed form carries every district; burying the dozen an institution operates
  in under 180 rows of zeros helps nobody checking a return.
- **A rate band with no lending prints as a dash, not 0%.** A loan type with no
  straight-line lending has no lowest rate, and zero would say it lends at
  nothing.

The period defaults to the last quarter that has *ended*. Defaulting to the
current one would open the screen on the API's refusal every time.

`apps/web/src/test-setup.ts` now unmounts between tests. Testing Library
registers that itself only under Vitest globals, which this project does not
use — without it every render accumulated in one document and queries failed as
"found multiple elements", which reads like a component bug rather than a
harness one.

---

## 19. Amendments — Finops Stage

### 19.1 A category is a BOT line, not a string

`finance_entries` carries no category column. It carries `(form_code, sno,
direction)`, a foreign key into `reference.form_lines`, and that key admits
only lines BOT accepts entry on, on the correct side of the statement.

Three classes of error the database now refuses outright, each verified by a
test that tries it:

- an entry against a line BOT **computes** (Sno23, the non-interest expense
  subtotal, would be double-counted against the sixteen lines beneath it);
- an expense recorded against an **income** line, or the reverse;
- a line number BOT does not publish.

This closes R12. The mechanism is a `UNIQUE (form_code, sno, entry_direction)`
on the reference table where `entry_direction` is `NULL` for every computed
line — a `NOT NULL` child column can never match a `NULL` parent, so "computed
lines take no entries" is enforced without a rule that says so.

### 19.2 Entries are dated, not bucketed by quarter

The previous schema scoped an entry to `(institution, year, quarter)`, which
makes the quarter something a person types. MSP2-02 carries a year-to-date
column, so the same rows must aggregate two ways, and §11.8 has not settled
whether that year is the calendar year or an institution's own fiscal year.

A date supports both. `compileMsp2_02` takes `fiscalYearStart` as a **required**
parameter — never defaulted, the same treatment `asAt` gets on MSP2-10 — so
whichever way §11.8 is answered, no row is restated.

### 19.3 MSP2-02's subtotals are derived, never re-summed

Seven of the forty-two lines are computed by BOT's template. Their composition
is written out once in `msp2-02.ts`, mirroring the formulas seeded in
`reference.form_lines.formula`, and the compiler **refuses** a taxonomy whose
structure does not match — a revised template fails loudly rather than
reporting subtotals that no longer describe the rows above them.

Losses are reported as negative figures. An institution whose interest expense
exceeds its interest income files a negative Sno13, and flooring that at zero
would report a profit that was not made.

### 19.4 `bank_accounts` — two sections listed, two typed in

MSP2-07 has four sections and BOT publishes a fixed list for only two of them:
banks in Tanzania (56) and MNOs (6). Balances with other microfinance providers
and with banks abroad are typed in by name. So the counterparty is a foreign
key for the first two and free text for the last two, and a check makes it
impossible to supply both or neither.

Two further facts are enforced by composite foreign key rather than by
application code:

- **An MNO cannot be filed as a bank.** A generated `reference_kind` column
  maps the holding kind onto BOT's own `kind`, and the key resolves against
  `(code, kind)`.
- **Agent banking follows BOT's list, not a preference.** `supports_agent_banking`
  must equal `reference.financial_institutions.in_agent_banking_list` exactly,
  so a balance can never be recorded against a bank MSP2-08 has no row for.

### 19.5 Foreign currency: the rate is recorded, not chosen

§11.6 asks which rate converts a foreign holding to TZS. That question is not
answered here, and it does not need to be for the data to be sound: a balance
row in any currency other than TZS must carry both an `exchange_rate` and the
`rate_date` it was taken on, or the check refuses it. Whatever an institution
used, the filed figure can be explained afterwards.

A TZS balance converts at par: the check requires the TZS columns to equal the
balances and forbids a rate, so the two can never quietly disagree.

The conversion itself happens in `@mfi/money` on the way in, never in the
database. A generated column would do the multiplication in double precision,
which is the one thing this system does not do with money.

### 19.6 Editable, unlike a payment

`finance_entries` grants UPDATE and DELETE, where `payments` grants neither. A
payment is evidence of money a borrower handed over; an expense entry is a
bookkeeping classification of the institution's own spending, and reclassifying
one between two BOT lines is ordinary work rather than a correction to a record
of fact. What makes it safe is that the audit trigger captures every move, so
"who put this figure on that line" stays answerable.

`bank_accounts` and `bank_account_balances` grant UPDATE but not DELETE: a
quarter's reported balance stays on the record, and closing an account is a
status change.

### 19.7 What this does not yet produce

MSP2-02, MSP2-07 and MSP2-08 now have compilers, but none of them can be
*filed* until MSP2-01 exists: every one of BOT's cross-validation rules for
these three forms (2, 9–15) ties a total to a balance-sheet line. They will be
reported as unavailable, exactly as rules 1, 4 and 16 already are, until stage
12 lands.

**A reading recorded rather than assumed.** §16.1 chose Option 1 — quarterly
financial-statement entry — for "MSP2-01 / MSP2-02 production", while §16.4
stage 11 calls for "expenses/income mapped to BOT lines". Every entered line on
MSP2-02 *is* an income or expense line, so the two are not alternatives: finance
entries are the source, and stage 12's statement dataset auto-populates MSP2-02
from them and locks it, in the same way Option 1 locks the loan-derived lines.
MSP2-01's 61 lines, most of which no operational system can derive, remain
entered.

### 19.8 The finance API, and one naming debt

`/finance/entries` (list, create, amend, delete), `/finance/bank-accounts`,
`/finance/bank-accounts/:id/balances`, and two reference endpoints that serve
BOT's own data — the MSP2-02 line taxonomy and the published institution lists.
A client builds its category picker from the first and its bank picker from the
second rather than embedding a copy, because a second list is a list that can
disagree with BOT's.

Every rule the schema enforces is checked in the use case first, against the
same taxonomy, so the refusal can name the field: a foreign-key violation says
only that a key did not match, while "that is a total BOT computes from the
lines beneath it" says what to do instead. The constraint stays underneath as
the floor.

Recording a balance is a `PUT`, not a `POST`. There is exactly one figure per
account per quarter and restating it as bank statements arrive is expected; a
`POST` would suggest a second could exist beside the first, which is what the
unique key forbids.

**The naming debt.** These routes are guarded on `expense.read` and
`expense.manage`. §9.2 describes the accountant as "finops, reports", and bank
balances are finops — but the permission's name is narrower than what it now
covers. Splitting it would create an authority no seeded role distinguishes, so
this is recorded rather than papered over with a second permission that always
travels with the first.

### 19.9 MSP2-02's year-to-date window is a request parameter

`fiscalYearStartMonth`, 1–12, defaulting to January — the same treatment §16.1
gave the rate convention, and for the same reason: §11.8 does not say whether
BOT reads the calendar year or the institution's own. The window actually used
comes back on the compiled form as `yearToDateFrom`, so a reader of a return
can see which answer produced it.

### 19.10 Seven forms compiled, three still waiting on the balance sheet

The compiled return now carries MSP2-02, -03, -04, -07, -08, -09 and -10.
MSP2-01, -05 and -06 remain unavailable and are named as such.

Compiling MSP2-07 and MSP2-08 made **no** validation rule checkable: every
cross-check BOT publishes for them (9–15) ties a total to a balance-sheet line.
They are reported alongside rules 1, 2, 4 and 16 as checks that could not be
performed. Producing a form is not the same as being able to verify it, and the
validator says which of the two happened.

### 19.11 The finance screens

Two routes, both behind `expense.read`, with the write controls behind
`expense.manage`: `/finance` for income and expenditure, `/finance/banks` for
accounts and their quarter-end balances.

**There is no category field.** The line picker is built from the taxonomy the
server serves, and the lines BOT computes are absent from it entirely — an
entry against a subtotal would be counted twice against the lines beneath it.
The server refuses it regardless; leaving it out of the list means nobody has
to be told. Changing the side clears a line chosen for the old one rather than
leaving it for the server to reject.

**The TZS equivalent is never entered.** A foreign balance is sent with its
rate and the server multiplies, so the figure filed is this system's arithmetic.
The screen asks for the rate and its date only when the account is not held in
shillings, and says why (§11.6).

**Agent-banking eligibility is never asked.** It is BOT's fact about the
institution, read from their list when the account is opened, so the field
simply does not exist on the form.

One client fix came out of this: `apiRequest` treated every successful response
as having a body, so a `204` from a delete rejected inside `json()` and
surfaced as a network error telling the user to retry something that had
already succeeded.

---

## 20. Amendments — Financial Statements Stage

### 20.1 MSP2-05's lines came from the template, not from guesswork

`bot-taxonomies.json` carries MSP2-01 and MSP2-02 and no others, so the eight
liquid-asset categories were read from the template's own `MSP2-05` sheet in
`docs/reference/`. That is supplied documentation; inventing labels for a
regulatory form would not have been.

Thirteen lines: four typed in (unencumbered securities and other liquid assets),
four restating MSP2-01 (rule 5), five computed.

### 20.2 "Locked" means having nowhere to write

§16.2 item 4 asks for lines that distinguish auto-derived from entered. The
distinction is enforced by a composite foreign key rather than a flag: a derived
line has `accepts_statement_entry` NULL in `reference.form_lines`, so
`financial_statement_lines` cannot resolve its key and the row is refused.

An institution therefore cannot supply a second answer to a question the loan
book already answers, because there is no column that would hold their version
of it. Eleven MSP2-01 lines are derived this way, and every one is named by §9's
list or by a BOT validation rule:

| Sno | Line | Source |
|---|---|---|
| 4, 5 | Non-agent and agent banking balances | MSP2-07 / MSP2-08 (rules 14, 15) |
| 6, 7 | Microfinance provider and MNO balances | MSP2-07 (rules 10, 11) |
| 18 | Loans to clients | the loan book |
| 22 | Allowance for probable losses | the provisioning engine |
| 37, 38 | Borrowings in Tanzania | MSP2-07 (rules 9, 10) |
| 43 | Borrowings from abroad | MSP2-07 (rule 13) |
| 46 | Cash collateral / compulsory savings | MSP2-10 (rule 16) |
| 59 | Profit or loss | MSP2-02 Sno42 year-to-date (rule 2) |

Accrued interest (Sno21), loans to staff (Sno19) and loans to other providers
(Sno20) stay **entered**: this system does not model them, and deriving a zero
would be asserting a figure rather than leaving it to the institution.

### 20.3 Sno34 is a heading, and BOT's own arithmetic says so

The template gives "8. LIABILITIES" an enterable cell. Sno50, Total Liabilities,
sums Sno35, 46, 47, 48 and 49 — not Sno34. A figure typed there is reported
nowhere and reduces no total, so it would vanish silently from a filed balance
sheet.

Entry is refused rather than accepted and discarded. This is the same class of
finding as the MSP2-04 weighted-average anomaly (§5.1 of the reporting spec),
and it gets the opposite treatment for a reason: there, BOT's formula produces
an output to replicate; here it produces none, so there is nothing to be
faithful to except the fact that the cell is dead.

### 20.4 An incomplete balance sheet compiles, and does not balance

`compileMsp2_01` reports the lines nobody has filled in yet rather than
refusing. A balance sheet is assembled over days as figures arrive from
elsewhere in the institution, and a compiler that refused until all thirty-five
entered lines were present would be unusable during exactly the period it is
needed.

Whether the result may be *filed* is a separate question, and rule 1 answers it:
an incomplete sheet does not balance. That is the one check on this form that
can genuinely fail, because its two sides are assembled from different figures —
most of the others hold by construction now that their lines are derived.

### 20.5 MSP2-05 reports a breach, not just a ratio

BOT sets a floor of 5% of total assets, and §6 of the reporting spec is explicit
that this is prudential rather than a disclosure: a breach is a supervisory
matter, and finding it at quarter-end submission is too late to act on. So
`compileMsp2_05` returns `excess` (negative when short) and `meetsRequirement`
alongside the ratio.

The ratio is `null` — not zero — when total assets are nil. Zero percent would
say an institution holds no liquidity, when in fact it holds nothing at all.

### 20.6 Nine forms compile, and eleven rules became real

The compiled return now carries MSP2-01, -02, -03, -04, -05, -07, -08, -09 and
-10. Only MSP2-06 remains unavailable, and it waits on complaints (stage 14).

Rules 1, 2, 4, 5, 6, 9–16 are now checked rather than reported as unavailable.
An honest note about most of them: they hold **by construction**, because the
lines they compare are derived from the same figures the other forms report.
That does not make them worthless — they catch a regression in
`derivedBalanceSheetFigures`, which is the only way they can now fail — but it
would be misleading to present eleven passing checks as eleven independent
confirmations.

**Rule 1 is the exception, and it is the valuable one.** Total assets against
total liabilities and capital compares two sides assembled from different
inputs, and an unfilled sheet fails it. Its message says how many lines are
still blank, because that is the first thing to check rather than something an
accountant should deduce by comparing two seven-figure totals by eye.

**Rule 6 reports a liquidity shortfall as a warning, not a block.** The return
is valid and says the institution is short; the breach is a supervisory matter,
and refusing to file would be the wrong response to it.

### 20.7 The statement screen has no freshness gate

Compiling a *return* refuses when overdue classifications are stale, because
filing on stale figures is the defect this system exists to prevent. Typing
last quarter's rent into a balance sheet is not filing, so
`GET /statements/:form/:year/:quarter` compiles without that gate. The gate
stays where the filing happens.

Both endpoints return the form compiled — derived lines filled in, totals
rolled up — so an accountant sees the balance sheet move as figures are entered
rather than discovering at submission that it does not balance. `compileForms`
exists so the two share one implementation rather than two that can drift.

`derivedBalanceSheetFigures` lives in `@mfi/domain` rather than the API: it
encodes how BOT's forms relate to one another, which is the same kind of
knowledge the validation rules encode and belongs beside them.

### 20.8 The statement screen

`/statements`, behind `expense.read`, with the inputs behind `expense.manage`.
One screen for both forms, chosen with the period.

Three kinds of line rendered three different ways, because conflating them would
hide which figures a person can actually change: **entered** lines are inputs,
**derived** lines are shown as figures with their source named, and **computed**
lines carry BOT's own arithmetic. There is no input for a derived line at all —
the API refuses one and the database has no row for it, so offering the control
would only invite a refusal.

Only changed figures are sent. The response is the recompiled form rather than
an acknowledgement, so a sheet that has just started balancing says so
immediately instead of after a refetch — and the screen leads with whether it
balances, which is BOT's first validation rule, rather than leaving that to be
discovered at submission.

A draft is cleared when the form or the quarter changes. Carrying it across
would offer to write last quarter's figures into this one.

---

## 21. Amendments — Compliance Stage

### 21.1 A filing is a record, not a query that can be re-run

`filed_returns` stores the whole compiled return as JSONB. Recompiling a past
quarter later produces a different document — the loan book has moved, a
mis-keyed payment has been reversed — and an institution asked to explain a
filed figure needs the document it sent, not this system's current opinion of
that quarter.

The document is immutable, enforced by a trigger rather than by convention:
only the submission reference may be added afterwards. There is no `DELETE`
policy and no privilege to grant one, because a filing that can be removed is
not a record of what was filed.

The system being replaced retained nothing at all — reports were generated in
the browser and never kept (R10, App Flow §4).

### 21.2 The filing refuses what BOT would reject

`POST /reports/msp2/:year/:quarter/filing` compiles first, so both gates apply:
the freshness gate inside the compilation, and then BOT's own validation rules.
A return with a blocking finding is one BOT's EDI validator will reject, and
filing it spends an institution's submission window to learn something this
system already knew. The refusal lists every blocking finding, keyed by the form
it concerns.

### 21.3 The cell map is not here yet, on purpose

§16.2 item 10 calls for a Sno-addressed cell map so the exporter writes by
`(form, Sno, column)`. It has exactly one consumer — the exporter that writes
BOT's workbook — and that is not built. A table nothing reads is the fault the
analysis records twice: `audit_logs` and `bot_reports` were both schema for
capabilities that were designed and never built. The map lands with the code
that reads it, as the domain-event seam did in stage 8.

The extraction is settled: for MSP2-01, MSP2-02 and MSP2-05, Sno *n* sits on row
13 + *n*, with amounts in column C and MSP2-02's year-to-date in column D. That
pattern will be seeded as data rather than encoded as arithmetic, because BOT
can insert a line and the fix should be a migration.

### 21.4 Rule 1 has a blind spot, and now something covers it

An entirely empty balance sheet **balances** — zero against zero — so every
arithmetic check BOT publishes passes on a form nobody has filled in. A dormant
institution genuinely files zeros; one that has not started filing produces the
same document, and no BOT rule can tell them apart.

Whether a figure was ever *entered* is the only thing that separates them, which
is what `missingEntries` records. The validator now warns when any entered line
has never been filled in, saying that a sheet of zeros balances trivially.

A warning and not a block: a line may be legitimately nil and never touched, and
refusing to file on that basis would be wrong. This is not one of BOT's rules —
it is the gap between what their rules can see and what an institution needs to
know before submitting.

### 21.5 The exporter fills BOT's workbook, and never argues with it

The cell map §21.3 deferred is now here, seeded by migration 0017 and read by
the exporter that is its only consumer. It is generated from the template itself
by `docs/reference/extract-bot-cells.py`, which resolves every taxonomy code
against migration 0004's seeds and fails at generation time on a name it cannot
match. The template moved to `apps/api/assets/` — it is no longer only reference
material, it is an input the running API reads.

Four tables rather than one, because BOT addresses four kinds of thing:

| Table | Holds |
| --- | --- |
| `reference.form_sheets` | Each form's tab, its Sno-to-row offset, and the column carrying the header block |
| `reference.form_columns` | This system's own field name → a spreadsheet column letter |
| `reference.form_rows` | A row, and the one thing it is about: an Sno, a sector, a loan type or a district — each a real foreign key |
| `reference.form_sections` | The blank ranges MSP2-07 and MSP2-08 are filled into in order |

`form_rows` uses an exclusive arc — four nullable code columns, a check that
exactly one is set, and a foreign key on each — so a map row naming a district
Tanzania does not have cannot be inserted at all. `(form_code, sno)` additionally
references `reference.form_lines`, which is what makes "the map cannot invent a
line BOT does not have" a database fact rather than a convention.

**The governing rule is that this system writes only where BOT has no formula.**
Every total, subtotal and ratio on the ten sheets is the template's own
arithmetic, and it is the arithmetic their EDI validator checks. Writing over
one would substitute ours; if the two ever disagreed, the institution would file
the wrong answer without seeing it. Computed cells therefore have no address in
the map at all — the same "locked means having nowhere to write" idiom as §20.2,
one layer out.

The conversion to a spreadsheet's doubles is the single place in this system
where a money figure stops being an exact decimal. It is checked rather than
assumed: the double is parsed back into a `Money` and compared, and a figure
that does not survive exactly refuses the export instead of rounding quietly.

### 21.6 BOT's template points at a file on somebody's machine

`BOT-MSP2-template.xlsx` carries an external link to `minne.xlsm`, which BOT
does not distribute with it. Four things resolve through that link:

- **The header block on nine of the ten sheets.** `MSP2-02!C2` and its eight
  siblings are `=[1]MSP2_01!C2`, cached as **"TESTING MSP"**, **"M001"** and
  **31-12-2021**. An institution that fills in the balance sheet and files the
  workbook sends nine forms carrying another institution's name.
- **`MSP2-05!C23` — Total Assets**, `=[1]MSP2_01!C46`, cached as **10**. The 5%
  minimum, the excess and the liquid-asset ratio are all computed from it, so
  three prudential figures on that form derive from a stale cell.
- **The `Banks` dropdown on MSP2-07** and **`Agent_Banking` on MSP2-08**, both
  defined as `'[1]Static Information'!…` — even though the workbook ships a
  local `Static Information` sheet holding identical values at identical
  addresses.

This is the third finding to raise with BOT, alongside the MSP2-04
weighted-average anomaly (§5.1 of the reporting spec) and MSP2-01's dead Sno34
cell (§20.3). It is treated differently from both: the anomaly is replicated
because BOT's formula produces an output, Sno34 refuses entry because it
produces none — and here the formulas produce a *wrong* output, so the exporter
overwrites them with the right one and repoints the two dropdowns at the sheet
the template already contains. Every repair is the value BOT's own formula was
reaching for; none of them changes what the form means.

### 21.7 What the round trip actually preserves

Writing a Node library over a regulator's workbook was the risk worth checking
before designing around it, so it was checked: all 6,138 populated cells across
the eleven sheets were compared before and after an untouched load-and-save.

Preserved: every sheet, all 906 formulas, cached results, styles, number
formats, merged ranges, data validations and the local lookup sheet. Four
differences, all the same cosmetic thing — a backslash dropped before a literal
parenthesis in a number format Excel reads identically either way. Two parts are
dropped on write: `calcChain.xml`, which Excel rebuilds, and the external-link
part, whose loss §21.6 turns into a repair rather than a regression.

One consequence needs stating plainly: every cached formula result in the
exported file is BOT's sample data until Excel recalculates. `fullCalcOnLoad` is
set so it recalculates on open — which means **a reader that parses the .xlsx
without evaluating formulas sees stale totals.** If BOT's validator turns out to
read cached values rather than recalculating, this system will have to compute
and write their totals too, and the "never argue with BOT's arithmetic" rule of
§21.5 would need revisiting. That is a question for BOT, not an assumption to
make quietly.

### 21.8 The export is of a filing, not of a quarter

`GET /filings/:id/workbook` builds from the archived document, never from a
fresh compilation, for the reason §21.1 gives: recompiling the same quarter
later produces a different answer. It carries `report.read` rather than
`report.generate` — deciding to file was the `report.generate` act that produced
the document, and rendering what was filed is reading it.

Two refusals live here rather than earlier. **No MSP code, no export**: BOT
prints it on all ten forms and keys submissions on it, and this is the pre-flight
check §11 promised, arriving where it bites. **A section that overflows refuses
the whole return**: BOT's MSP2-07 allows twenty-nine banks and MSP2-08
twenty-eight, and an institution with more counterparties than rows has a real
problem BOT has to answer — filing a return quietly short by one bank is not a
solution to it. MSP2-08's compiled form does carry a row per published
institution so that its total is provably over all of them; only the non-zero
ones are written, because a zero row says nothing the total does not and BOT's
sheet has no cell for it to say it in.

### 21.9 The PDF is for a reader, and is not a second submission

§11 promised PDF alongside XLSX. It is worth being precise about what it is for,
because the two are not alternatives: BOT takes the workbook, and nothing this
system produces as a PDF is uploadable. The PDF is the document a board signs
before anything is sent, an auditor is handed afterwards, and a file keeps.

That makes it a different document rather than a second rendering of the same
one. It carries three things the workbook structurally cannot:

- **Who filed it, when, and against which acknowledgement.** BOT's template has
  no cell for any of that; the filing record does.
- **Every validation finding as it stood at the moment of filing.** Warnings are
  printed in full rather than counted, because "three warnings" tells a board
  nothing and the warnings are the part worth reading before signing.
- **The forms the return does not carry**, named with their reasons, so a
  partial return is never read as a complete one.

It shares the two properties that matter with the workbook. It is built from the
**archived document**, so the two can never disagree about what was sent. And
**no figure is recomputed** — every amount is the string the archive holds,
printed as it stands. A renderer that re-totalled a column could disagree with
the return, and the return is the record. Codes become names here and only here,
which is the one thing the renderer needs reference data for.

**pdfkit, not a headless browser.** Rendering HTML in Chromium would give richer
layout at the cost of a browser in every production container, a process to
supervise and a sandbox to keep patched — for a document that is nine tables.
pdfkit draws directly, needs no font files for the standard Helvetica it uses,
and adds no runtime beyond Node. If the PDF ever needs to look like a designed
document rather than a legible one, that trade is worth revisiting; it is not
worth making in advance.

Two layout decisions are worth recording because they lose something. MSP2-10's
fifteen numeric columns will not fit across a page at a size anyone can read, so
they are **split across two tables over the same district rows** — every figure
appears, in two passes rather than one. And districts the institution has
nothing in are **left out of the PDF**, while the workbook still files all 193,
because BOT's grand total is over the whole country and ten pages of zeros does
not help a reader see where an institution actually operates. The count of
omitted districts is printed, so the omission is visible rather than silent.

## 22. Amendments — Complaints Stage

### 22.1 MSP2-06 is a movement statement, so complaints are records

Every other form on the return reports a position as at the quarter end.
MSP2-06 reports a *movement*: opening, plus new, less those resolved by the
institution and by other parties, gives what was unresolved at the quarter end —
as a count, a TZS value, and a split across BOT's six nature categories, with
four further lines counting where the unresolved ones were referred.

No stored quarterly figure can answer any of that. So complaints are kept as
records with dates, and **every line of the form is derived from them**,
including the opening balance. The alternative — an entered dataset, as MSP2-01
is — would make an institution retype last quarter's closing figure as this
quarter's opening one, and a single typo would then propagate through every
return that followed it. Here, restating an old quarter is a matter of asking
the same question with different dates.

The prior documents described complaints as "resolved / unresolved counts",
which is the gap §8 of the reporting spec identified. What was missing is a
monetary value, a resolution *route* (institution or other party — BOT's lines 3
and 4 are the only ways a complaint leaves the unresolved population), and a
dated referral destination.

### 22.2 BOT's rule 8 is an identity, not arithmetic — because of a CHECK

The compiler derives the closing line directly from the records, and BOT's
template computes it from the four lines above. That the two agree is not a
coincidence and not something this system arranges: a complaint resolved inside
the quarter was either open at the start or received during it, so the closing
set is exactly opening plus new less resolved — **provided a complaint cannot be
resolved before it was received**.

That proviso is `complaints_resolved_after_received`, a database check. Without
it the roll-forward is a claim; with it, it is an identity. The validator checks
rule 8 anyway, because the guarantee lives in a constraint a future migration
could weaken, and it checks rule 7 for the same reason. That completes all
eighteen of BOT's published rules.

The workbook writes the eight lines BOT accepts entry on and leaves row 18 to
their formula, so the figure this system derives and the figure their sheet
computes are produced independently. Rule 8 is what makes sure they agree before
anything is filed.

### 22.3 Three refusals that are about dates

- **A resolution dated before the complaint arrived** is refused, naming the
  roll-forward it would break.
- **A referral on a resolved complaint** is refused: BOT's lines 6 to 9 count
  referrals of *unresolved* complaints, so it would be counted nowhere.
- **Any of these dated in the future** is refused, because MSP2-06 counts as at
  a quarter end and a figure dated next month would appear on no return until
  that month arrives — and then on one that may already have been filed.

Resolving is guarded by `resolved_on IS NULL` in the UPDATE predicate rather
than by a read-then-write, so two operators closing the same complaint at once
cannot both succeed and overwrite one another's route and note. There is no
DELETE and no privilege for one: a complaint counted on a filed return cannot be
made not to have happened, and one logged in error is resolved with a note
saying so.

### 22.4 A complainant need not be a client

`client_id` is nullable. Somebody refused a loan, or a guarantor pursued for one
they did not take, has a complaint BOT counts and no client record to hang it
on. Refusing to log one because the complainant is not on the books would lose
it from the return entirely — which is the opposite of what the form is for.

Logging is guarded by `complaint.manage`, which the seeded catalogue gives the
loan officer and the branch manager as well as the accountant. A complaint is
usually made to the person the borrower already deals with, and a system where
only head office can log one gets complaints logged late or not at all.

### 22.5 All ten forms

`unavailableForms` is now empty, and it stays in the wire contract rather than
being deleted. A client that stopped reading it would present a partial return
as a complete one the next time a form went missing, and the institution would
find out at the filing desk — which is the failure §11 introduced the field to
prevent.

## 23. Amendments — Savings Stage

### 23.1 Less than a savings subsystem, on purpose

§13.4 asks for the interest rate basis, the accrual frequency, the minimum
balance, the withdrawal rules and whether savings can secure a loan. None of
those are answered, so **none of them are built**. There is no interest anywhere
in this stage: a balance is what was paid in less what was taken out.

What is built is what BOT's return could not be filed without. Compulsory
savings appears on three forms — MSP2-01 Sno46, MSP2-03's provision deduction,
and MSP2-10's per-district column — and until now all three reported nil with a
validator warning saying so.

Two rules are enforced that §13.4 does not cover, and neither is a product
decision:

- **A balance cannot go negative.** A negative savings balance is an overdraft,
  which is a lending product this institution does not offer, and one would turn
  money owed *to* a client into money owed *by* them — the wrong side of
  MSP2-01. Whether a client may draw their compulsory savings to nothing *while
  a loan is outstanding* is a different question, and that one is §13.4's.
- **An entry cannot be dated in the future.** MSP2-10 reports the balance as at
  a quarter end; a figure dated next month would appear on no return until that
  month arrives, and then on one that may already have been filed.

### 23.2 Compulsory is a flag, because it decides what gets reported

`savings_products.is_compulsory` is a column rather than a naming convention. It
decides whether a balance appears on three BOT forms or on none, so a product
misfiled as voluntary silently removes money from a regulatory return. Defining
a product is therefore `settings.manage`, not `savings.manage` — an
institution-level decision rather than something done between transactions.

### 23.3 Two opposite groupings on the same form

MSP2-10 groups branches and employees by **where the branch is**, and compulsory
savings by **where the saver is**. That is deliberate, not an inconsistency:
counting branches by the districts their clients live in would file four
branches where there is one (§18 recorded that), while counting savings by the
branch's district would report a Karatu farmer's savings in Arusha City.

A district can have one and not the other — an institution lends into districts
it has no office in — so the two are merged as a **union of both key sets**.
Looking savings up from the branch list would drop a district that has savings
and no branch, and the money with it.

### 23.4 As at the quarter end, from the ledger

The per-district figure is summed from the dated ledger, not read from
`savings_accounts.balance`. That column is as at *today*; the return needs as at
*the quarter end*, and restating a filed quarter has to give the figure that
quarter had. It is the same discipline MSP2-06's roll-forward follows and the
same one the loan book's point-in-time restatement uses.

The balance column still exists, and is authoritative for the overdraft check —
because that check has to be atomic with the withdrawal that would breach it. A
`SUM` taken before the write is a race; a column with a `CHECK` is not. The
account row is locked with `FOR UPDATE` before its balance is read, so two
tellers emptying the same account serialise instead of both seeing the balance
that existed before either of them.

Three layers hold one rule — the domain states it, the lock makes it meaningful
under concurrency, the constraint catches a future path that forgets both — and
that is not duplication so much as defence in depth around the only figure in
this module a client would notice being wrong.

### 23.5 MSP2-03's collateral deduction is still nil, and that is a decision

BOT deducts "Cash Collateral / Insurance Guarantee / Compulsory Savings" from
the provision on MSP2-03, **per sector**. This stage does not wire it, and the
reason is §11.7: whether compulsory savings is a savings-product attribute, a
per-loan collateral amount, or both, has not been settled. Under the first
reading a client with two loans in different sectors has no defined split of
their savings between them, and any split this system chose would be invented.

Leaving it nil **over-provisions**, which is the safe direction to be wrong on a
regulatory return: it overstates the allowance for probable losses rather than
understating it, and an institution that reports a larger provision than it owes
has not misled its regulator in its own favour. Getting it wrong the other way
would.

The existing validator warning stays until it is answered.

**Superseded by §24.1.** The answer arrived in the same session: compulsory
savings is a per-loan collateral amount, so the deduction is a sum over the
loans in a sector and needs no attribution rule. It is wired, and the
placeholder above is history rather than current behaviour.

## 24. Answers to §13

Recorded here as they arrive, because §13's questions are referenced from
migrations and module headers throughout, and a decision that lives only in a
conversation is one the next person cannot find.

### 24.1 §11.7 — compulsory savings is a per-loan collateral amount

**Answered: per-loan collateral amount.** Each loan carries how much compulsory
savings secures it. The money still sits in a savings account — that is what
MSP2-01 Sno46 and MSP2-10 report — but the amount securing a given loan is
recorded against the loan.

This makes MSP2-03's deduction exact rather than attributed: a loan belongs to
one sector, so the per-sector "Cash Collateral / Insurance Guarantee /
Compulsory Savings" figure is a sum, not a split. §23.5's nil placeholder and
the validator warning that accompanies it can now be replaced with the real
figure.

The constraint that has to hold: the total secured across a client's loans
cannot exceed their compulsory savings balance, or the return would deduct
security the institution does not hold.

### 24.2 §13.1 — penalties

**Answered: the recommended shape.** Configured per loan product: a penalty
rate, basis = **overdue instalment amount**, a grace period in days, accrual
**daily, simple, non-compounding**, and an optional cap as a percentage of
principal.

**Still outstanding: the default values.** The shape can be built without them —
the columns, the accrual, the allocation — but no product can be seeded and no
penalty computed until the rate, the grace period and the cap are given. They
are per-product configuration, so they can arrive after the mechanism.

### 24.3 §13.2 — allocation order

**Answered: penalties → fees → interest → principal.** This replaces the
documented build's interest → principal, which had no penalty concept at all.

The consequence for stage 8's allocation engine is that it gains two buckets
ahead of the two it has, and that reversals have to unwind them in the same
order. The existing allocation is exact-decimal and tested against golden
vectors; the new buckets join that treatment rather than sitting beside it.

### 24.4 What §24.1 changed, concretely

`loans.compulsory_savings_secured` records how much of a borrower's compulsory
savings stands behind each loan, and MSP2-03's per-sector deduction is a sum
over it — restricted to the loans that form actually reports, so a loan
disbursed after the quarter end brings no security onto that return and a
settled loan releases what secured it.

One invariant needed a **trigger rather than a CHECK**, because it spans rows:
the total secured across a borrower's loans may not exceed their compulsory
savings balance. Without it two loans could each claim the same shilling and
MSP2-03 would deduct it twice — reporting a smaller provision than the
institution owes, which is the direction of error a regulator cares about. It
is not checked in the use case, because a read-then-write check races: two
concurrent calls could each pass it and the pair still break it.

The savings balance itself is unchanged by any of this. The money is in the
savings account, reported on MSP2-01 Sno46 and MSP2-10; the loan records only
how much of it is pledged.

### 24.5 The penalty mechanism, without the figures

§13.1's shape is built; §13.1's **values are still outstanding**, and the split
between those two is the point of this increment.

`loan_products` gains `penalty_daily_rate`, `penalty_grace_days` and
`penalty_cap_fraction`, all **nullable, all unseeded**. A product with no terms
charges nothing. Inventing a plausible rate would put a fabricated charge on a
borrower's account, which is the failure §13 exists to prevent — so the columns
wait for the institution to fill them.

Two constraints keep a half-configured product from looking configured: terms
are whole or absent (`(rate IS NULL) = (grace IS NULL)`), and a cap without
terms to cap is refused. A grace period with no rate would charge nothing while
reading on screen as a deliberate policy, which is worse than an empty field.

**The basis and the accrual method are not columns.** Overdue-instalment basis
and simple daily non-compounding accrual are §13.1's answer, not a per-product
choice, and a column would invite a second answer to a question that has one.
Changing either is a migration and a domain change together.

`accruePenalty` in the domain does the arithmetic, and three properties are
worth naming because each is a decision:

- **The base is the overdue instalment**, so two missed instalments accrue
  separately from when each fell due, rather than as one arrears figure from the
  earliest date.
- **Rounded once over the whole period**, not once per day. A daily charge of a
  third of a cent rounds to nothing per day and to three cents over ten days;
  rounding per day would bill a cent a day and drift from the agreement's own
  arithmetic in the institution's favour.
- **As at a date**, like every other figure here. Re-running the accrual cannot
  change a figure already reported.

The rate is a plain decimal fraction rather than a `Rate`, because `Rate` in
this codebase means a *monthly* interest rate — it converts to monthly
percentages and annualises for MSP2-04. A daily penalty rate borrowing the type
would inherit arithmetic that means something else.

Still to come: the penalty balance on a loan, and the accrual job.

### 24.6 §13.2's answer cost one constant

The allocation engine was built in stage 8 with all four buckets already named —
penalty, fee, interest, principal — and with the order as a **parameter** rather
than a constant, precisely because §13.2 was open. Applying the answer was
therefore a one-line change to a default, not a redesign of the payment engine.

`ALLOCATION_ORDER` is now penalties → fees → interest → principal and is the
default. `DOCUMENTED_ALLOCATION_ORDER` stays exported and unused for allocation:
it is what the system being replaced did, and a reader comparing a historical
split against this system's needs to be able to name the difference.

Two properties are pinned by tests rather than asserted in prose:

- **With no penalty and no fee outstanding, the new order splits a payment
  exactly as the old one did.** That is what makes the change safe to apply to a
  live book — every existing payment would have landed where it did.
- **The fee bucket is present and nil**, not absent. §13.8 has not settled what
  a loan fee is, so nothing accrues to it; its *position* is nonetheless decided.
  Fixing the position now matters: adding the bucket later would silently change
  how every earlier payment would have been split.

Penalties allocate nothing yet either, for a different reason — the terms exist
(§24.5) but no balance accrues to a loan until the accrual job does. The order
is ready for both.

### 24.7 The penalty balance, and the watermark that makes it trustworthy

`loans.penalty_balance` carries what a loan has accrued and not yet paid, and
the payment path now reads it into the allocation's first bucket and reduces it
by what a payment settled. A reversal adds it back — the same amount, negated —
so undoing a payment restores the penalty it cleared as well as the principal it
reduced.

`loans.penalty_accrued_to` is the date accrual has been computed to, and it is
the column that makes the balance mean anything. Without a watermark, "accrue
penalty" is a question about how many times the job has run rather than about
the loan: run it twice on a Tuesday and the borrower owes twice as much. With
one, the job charges the days between the watermark and the date it is asked
about, and running it again the same day charges nothing.

NULL until the first accrual, which is deliberately distinct from a watermark
set to the disbursement date. A loan never accrued and a loan accrued to its
first day are different states, and only the second means "the days before this
were considered and charged nothing."

Two constraints hold the pair together: a non-zero balance implies an accrual
happened, and nothing accrues before money is lent. The first is
one-directional, because accruing a loan that is not overdue correctly leaves
the balance at nothing.

The payments table already had `penalty_portion` and `fee_portion` columns from
stage 8, for the same reason the allocator already had four buckets: the shape
of the answer was anticipated even where the answer was not.

**Still outstanding: the accrual job itself**, and §13.1's default values
without which it would charge nothing anyway.

### 24.8 Which instalments are overdue is derived, not stored

A repayment in this system settles penalty, then interest, then principal
*across the loan* — it is not applied to a named instalment. So "which
instalment is unpaid" is not a stored fact, and the penalty engine needs it.

`overdueInstalments` derives it the way arrears always are: run the schedule
forward, run the receipts against it, and the shortfall lands on the oldest
instalments first. That is the **same** cumulative-schedule-versus-receipts
method the reporting layer already uses to derive days overdue for MSP2-03's
classification, and reusing it rather than writing a second one is deliberate.
Two ways of deciding what is overdue would eventually disagree, and one of them
would be charging a borrower.

Instalments not yet due are excluded, so a borrower who has paid nothing owes
penalty on what has fallen due rather than on the whole schedule — and paying
ahead settles what is due without making a future instalment overdue.

A test runs the two functions together and pins the property that matters end to
end: penalty is charged on the same instalments the arrears calculation calls
overdue, from the same dates.

What remains is the job that walks the book and persists the result — repository
work rather than a decision, and idle until §13.1's values arrive.

## 25. Hardening notes

### 25.1 A pooled client cannot run two queries at once

Several repositories issued their reads through `Promise.all` on a single
transaction client. That parallelism was never real: a `pg.PoolClient` is one
connection, the driver serialises concurrent statements on it, and it warns —
loudly, across every test run — that it will stop doing so in `pg@9`. The
results were correct; the shape was a latent break on the next major version and
a misleading claim about what the code does.

The two reference-data reads that ran once per process are now sequential — six
small lookups on process start, where the notional saving was nothing at all.

The three sites in `report-repository.ts` are converted too, and the way they
were is worth a line. Splitting each `Promise.all` argument on commas mangled
the comments between its elements — the ones recording that BOT's taxonomy order
*is* the form layout, and that sorting by code would file every figure one row
out. The transformation that worked left the array literal exactly as it was and
only awaited each element in place: nineteen call sites, three wrappers, and not
a comment moved.

No `Promise.all` on a transaction client remains anywhere in the API.

### 24.9 The accrual job, and why it charges an increment

`POST /penalties/accrual` walks the book to a date. It is an endpoint rather
than a timer: a scheduled job would still call it, and having the operation
reachable means it can be re-run after a failure or caught up after an outage
without waiting for a timer to come round. It is guarded by `loan.write_off` —
the only seeded permission that represents authority to change what a borrower
owes without a payment behind it.

**It charges an increment, not a total.** For each loan it computes the accrual
to the requested date and the accrual to the existing watermark, and adds the
difference. Writing the total instead would be simpler and wrong: the balance
already holds what earlier runs charged, and a payment may since have reduced
it — overwriting would silently undo that payment.

That is what makes the operation idempotent, and a test asserts it directly:
running the accrual twice for the same date leaves the balance untouched.
Another moves the date forward ten days on the same arrears and checks the
charge doubles rather than being recomputed from scratch.

A loan never accrued starts from its disbursement date, so its first run covers
its whole life. A loan whose product has no penalty terms is not selected at
all — which today is every loan in every institution, and the job correctly
reports considering none of them.

Receipts are netted of reversals, so "what has been received" means money the
institution still holds. That matters here because arrears drive the charge: a
reversed payment must put the borrower back into arrears, and a penalty computed
against a payment that was undone would be a charge for a debt that existed.

### 24.10 An approximation in the accrual, and which way it errs

Re-reading the accrual after writing it, there is an imprecision worth stating
rather than leaving for someone to find in a borrower's statement.

The job computes the arrears position **as at the date being accrued to**, then
charges the difference between the accrual to that date and the accrual to the
watermark — using that same arrears position for both. So the whole window is
charged against the arrears that exist at its end, not against the arrears that
existed on each day of it.

Where a new instalment falls due inside the window, this is exact: that
instalment's days-to-watermark clamp to zero, so it is charged from its own due
date and grace period, not from the watermark.

Where a borrower **reduces** their arrears inside the window, it is not exact.
The smaller closing position is applied across the whole window, so the borrower
is charged less than a day-by-day replay would produce. That is the direction to
be wrong in — a penalty is a charge against a customer, and an approximation
that favours the institution would be a defect rather than a rounding.

Making it exact needs the receipt timeline replayed day by day, which is a
larger change and a real cost on a book of any size. It is recorded here as a
known approximation with its direction of error stated, and the daily run that
the design assumes shrinks the window to a single day, where the two methods
agree exactly. The imprecision only appears when the job has not run for a while
and a borrower paid during the gap.

### 24.11 §13.3 — rejection returns an application to the officer

**Answered: a rejected application goes back to the officer as a draft.**

Rejection is not terminal. The reasons a decision comes back are usually a
missing document or a term that needs changing, not a judgement that the
borrower should never be lent to, so the officer revises and resubmits rather
than rekeying the whole application.

The rejection is still recorded. The decision path moves the loan through
`rejected` — capturing the decider, the timestamp and the required reason, and
firing the audit trigger — and then on to `draft` in the same transaction. The
history says "rejected by X on Y because Z"; the officer's queue says "draft,
needs work", with the reason attached. `submitted_by` and `submitted_at` are
cleared, because the application will be submitted again and those fields
describe the submission that is now undone.

The status machine gains one transition, `rejected → draft`. Without it the
second step would be refused and the loan would sit in a state nothing could
move it out of — which is what "rejection is terminal" meant in practice.

**The threshold figures themselves are still outstanding, but they are no longer
a question for anyone to answer in the abstract.** `approval_thresholds` is read
by the approval check and written by nothing: there is no endpoint and no
screen, so even an answer had nowhere to go. The same is true of penalty terms —
`loan_products` carries the columns and `/loan-products` is GET-only, so a
product cannot be created through the API at all. That is a missing settings
surface rather than a missing decision, and it is the next piece of work.

### 25.2 CORS was missing PUT, and the suites could not see it

The web client has issued `PUT` since the statements screen was built —
`/statements/:form/:year/:quarter` is how a balance sheet is saved. The server's
CORS configuration listed `GET, POST, PATCH, DELETE`.

A browser preflighting that request would have been refused, and every test
passed regardless, because Fastify's `inject` addresses the router directly and
never goes through CORS. So the statements screen worked in 1,400 tests and
would have failed the first time a person opened it.

`PUT` is now in the list. The general lesson is the one this session keeps
teaching: a suite that bypasses a layer cannot test that layer, and the gap is
invisible precisely where the tests are greenest.

## 26. Settings — where an institution's own figures go

§13.3 asked an institution for its approval thresholds as though they were a
decision somebody could give once. They are not. Two providers will set them
differently, both will change them next year, and no answer belongs in a
migration this system ships.

The deeper problem was that there was nowhere to put an answer. `approval_thresholds`
was read by the approval check and written by nothing — no endpoint, no screen —
so the lending workflow was inert and the fix was not a decision but a missing
surface.

`GET /settings/approval-thresholds` lists **every role**, including those with no
limit, because a screen has to show "no authority" as a state rather than as an
absent row. `PUT /settings/approval-thresholds/:role` sets one, and passing
`null` clears it — which *removes* the authority rather than making it
unlimited. That is the same reading the table was seeded empty for: a missing
row means a role may sanction nothing.

Writing is `settings.manage`, held by the institution administrator alone. A
role that could raise its own limit would not be a limit. Reading is `loan.read`,
because an officer needs to know what can be sanctioned before submitting an
application that would be refused.

### 26.1 Loan products — the second half of the same surface

`/loan-products` was GET-only, and the omission had gone unnoticed for the same
reason the thresholds gap had: the tests inserted products with raw SQL, so
every lending path worked without anyone needing the endpoint that did not
exist. An institution could not define a single product through the API.

`POST /loan-products` closes it, and it is where §13.1's penalty figures enter
the system. Migration 0021 gave penalty terms a shape and deliberately no
values; this gives the institution somewhere to state them. Nothing here
supplies a default. A product created without penalty terms charges no penalty
and is a complete product, not an unfinished one.

Writing is `settings.manage` rather than `loan.create`, on the same reasoning as
savings products: a product fixes the rate band, the term band, the principal
band, the BOT loan type every loan of it reports under, and the penalty terms
every borrower on it is charged. That is institution policy, not something an
officer settles while entering an application.

Every rule the request schema enforces is also a constraint in migration 0008 or
0021, and both copies earn their place. The database's is what holds — it cannot
be bypassed by a future write path. The schema's is what the person filling in
the form reads: `loan_products_penalty_terms_are_whole` names a constraint,
while "penalty terms need both a daily rate and a grace period" names the field
they left empty. One rule is enforced only in the schema, because the database
cannot see it: a penalty cap of zero passes `penalty_cap_fraction > 0`'s sibling
checks in spirit but would silently make the terms beside it charge nothing.

### 26.2 A floating-point comparison that was correct, and still removed

The product schema has to compare two amounts — the maximum principal against
the minimum — and the first draft did it as `Number(a) >= Number(b)`.

That is correct today, and the honesty matters: `MONEY_PATTERN` admits at most
thirteen digits before the point and two after, so every amount this system
accepts is under 10^13 while doubles are exact to about 9 × 10^15. No two
distinct amounts collapse onto one double. There was no bug.

It was correct *by accident of the current column width*, which is the reason it
went anyway. Nothing recorded the dependency, and the day `NUMERIC(15,2)` widens
— or the comparison is copied somewhere a value is not so bounded — it becomes
wrong silently, admitting a product whose maximum principal is below its
minimum because two different figures compared equal. A rule that money never
passes through a binary double is not a rule anyone can apply if it carries a
case-by-case exemption for "this width happens to be safe".

`compareDecimalStrings` in `@mfi/contracts` compares the digits instead. It is
not arithmetic and does not import `@mfi/money` — §2 keeps that package out of
the browser bundle, and a comparison of two strings already validated as
canonical decimals needs none of it.

### 26.3 The screen

`/settings`, guarded by `settings.manage` — not by a read permission, because
every control on it writes and a read-only view would be a page whose only
buttons all fail.

Two panels, matching the two halves. Approval limits list every role, with an
unset one shown as **"No authority"** rather than as `0.00` or as blank: zero
reads as a limit somebody chose, blank reads as still loading, and the truth is
neither. Clearing a limit is a separate button labelled "Remove authority",
because the destructive reading is the correct one and the label should say so.

The product form has no default in it. The penalty fields appear behind a
checkbox and are sent as one group or omitted entirely — never as empty strings
the server would have to interpret — and the cap is dropped from the request
when left blank rather than sent as `''`. Nothing on the screen computes: every
amount and rate travels as the string that was typed, and the bounds the form
implies are checked again by the server and by a database constraint beneath it.

`GET /reference/loan-types` was added for the type selector, on the same
reasoning as the finance module's reference endpoints: a second copy of BOT's
list is a list that can disagree with BOT's, and this one decides which MSP2-04
row every loan of a product reports on. It carries `parentCode`, so the two
Salaried sub-types render indented under their parent — BOT's template gives the
parent an input row of its own at row 23 as well as its children at 24 and 25,
so all three are choosable and the screen shows the structure rather than
fourteen flat options.

### 26.4 A labelling defect the settings screen exposed

The settings forms use the shared `Field` primitive rather than the hand-rolled
`<label><span/>…</label>` several older screens used. The difference is not
cosmetic: with the hint rendered *inside* the `<label>`, a control's accessible
name becomes its label **plus** its hint, so a screen reader announces

> "Currency Anything but TZS needs a rate and rate date on every balance"

where it should announce "Currency". The same happens when a field error is
rendered inside the label — the error text joins the field's name too, so the
name changes the moment the field is wrong.

The settings tests found it immediately, because `getByLabelText` looks up a
control by its accessible name and `getByLabelText('BOT loan type')` matched
nothing. That is the whole reason the defect had survived elsewhere:
`bank-balances-page.tsx` had **no test file at all**, and the two screens that
did have tests had never queried these particular fields by label.

Five sites are converted — one on the finance page, one on the reports page,
three on the bank-balances page — and `Field` now supplies the label, ties the
hint and the error with `aria-describedby`, and sets `aria-invalid`. Three new
tests assert each control's accessible name is the label alone and that the hint
is still reachable as a description, so the regression cannot return quietly.

`bank-balances-page.tsx` also gained the test file it never had, covering the
labelling and the property that matters most on that screen: a foreign balance
is sent in its own currency with the rate it was taken at, and no TZS equivalent
is computed in the browser.

### 26.5 What this surface still lacks

Amending or retiring a product is absent. `loan_products.status` carries
`'retired'` and nothing sets it, so a product defined in error stays on the
officer's list. Loans copy their terms from the product at creation rather than
referencing it (§9), so retiring one is safe to add and does not disturb loans
already written against it.

## 27. Complaints, on screen

MSP2-06 had a compiler, a table, an API and no way for anyone to enter a
complaint. The form would have compiled zeros forever and looked correct doing
it.

`/complaints` records **dated facts and never a tally**. There is no field
asking how many complaints were resolved this quarter, because the return works
that out from when each one was received and when it was resolved — which is the
whole reason §22 keeps records rather than quarterly figures. The screen asks
"received on" and never "which quarter", for the same reason the finance screen
does.

Two vocabularies come from the server rather than from a list in the bundle. The
**nature** is one of BOT's six categories — their form has a column for each and
no room for a seventh — and the **resolution route** is one of the two lines by
which a complaint leaves the unresolved population. A resolution naming neither
would vanish from the roll-forward, which is why the contract requires it and
the screen offers exactly two options.

The disputed amount is omitted from the request when left blank rather than sent
as an empty string. Blank means no amount is in dispute; zero means an amount of
nothing. Sending `''` would make the server choose which was meant.

### 27.1 `GET /branches`, which nothing could do without

Logging a complaint needs a branch, and there was no way to obtain one. The
session carries the signed-in user's branch, but it is `null` for a user with
institution-wide authority — so a screen reading only the session would have
left exactly the administrators unable to file anything at all.

`GET /branches` is guarded by `branch.read`, which a branch officer holds too:
an officer confined to one branch still needs the list, because a record is
filed against a named branch and theirs is only one of the choices. Closed
branches are returned as well as open ones — a record filed against a branch
that has since closed still has to render with a name rather than a bare
identifier — and a picker filters to the active ones itself.

### 27.2 A shared `Badge`

The stylesheet defined five badge tones and `StatusBadge` exposed none of them
to a caller; it mapped a loan status to a tone through a private table. The
complaint states are not loan statuses, so this screen would have had to write
`<span className="badge badge--warning">` and quietly own a sixth spelling of a
shared idea.

`Badge` now takes one of the five tones as a named union, and `StatusBadge` is
expressed in terms of it — so a status is never two colours in two places, and
the rule that a badge always renders text rather than colour alone lives in one
component instead of in a convention.

## 28. Savings, on screen

The same gap as complaints, on a larger surface: savings had a ledger, a
repository, an API and no way for a teller to record a shilling. MSP2-01 Sno46,
MSP2-03's provision deduction and MSP2-10's per-district column would all have
reported zero.

`/savings` is deliberately **less than a savings subsystem**, and the omissions
are the design. §13.4 asks for the interest rate basis, the accrual frequency,
the minimum balance and the withdrawal rules, and none of those are answered —
so there is no interest control anywhere on the screen and a balance is what was
paid in less what was taken out. A rate here would be a fabricated credit on a
saver's account, which is exactly what §13 exists to prevent. A test asserts the
absence, because an omission nothing checks is an omission that gets filled in
later by someone who assumes it was an oversight.

**No balance is ever sent.** A deposit sends the amount and the date; the server
locks the account row, refuses an overdraft, and writes the entry and the new
balance in one transaction. The figure shown afterwards is the server's. A
browser computing it would be computing from a balance that may already be stale
by the time the request lands.

A product's compulsory flag is rendered on every account and on every option in
the product picker. It is not a naming convention: it decides whether those
balances appear on three BOT forms or on none, with validation rule 16 tying
MSP2-10's district column back to MSP2-01 Sno46.

The statement marks reversing entries. There is no edit and no delete on this
screen because the database grants neither privilege — a mistake is corrected by
a reversing entry that leaves both the error and the correction visible.

### 28.1 A limitation stated rather than hidden

The saver picker lists the first hundred active borrowers. An institution with
more has savers it cannot select, and the field says so when the list is
truncated rather than silently ending at a hundred. The fix is a
search-as-you-type picker against `GET /clients`, which already takes a `search`
parameter; it is a piece of work in its own right and is not smuggled into this
one.

`Field`'s `hint` now accepts `string | undefined`, matching `error`. Under
`exactOptionalPropertyTypes` a conditionally-present hint could not otherwise be
passed without a spread at every call site.
