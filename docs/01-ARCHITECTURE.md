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
