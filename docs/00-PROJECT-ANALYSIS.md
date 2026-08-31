# Project Analysis — MFI Manager

**Author:** Architecture review, pre-implementation
**Date:** 2026-08-07
**Status:** Awaiting approval. No implementation code has been written.
**Inputs:** PRD v1.0, TRD v1.0, Schema Reference v1.0, App Flow, UX Brief,
Implementation Plan.

---

## 0. Finding That Precedes Everything Else

The six documents are written as *reverse-engineered descriptions of a
codebase that already exists*. The TRD states "78 files, statically
import-checked." The Schema Reference describes `supabase/schema.sql` as
"the single schema.sql file in the verified build." The App Flow quotes
`router.tsx` "verbatim." The Implementation Plan's Phase 0 is entirely
about proving that existing build compiles.

**That codebase is not in this repository.** The repo at
`mine3438/microfinance-` contains exactly two files — `LICENSE` and a
25-byte `README.md` — on a single commit (`f88c492 Initial commit`).
There is no `package.json`, no `src/`, no `supabase/`, no schema, no
tests.

Three possibilities, and the answer changes the entire plan:

1. **The code exists elsewhere** (another repo, a local machine, a prior
   session's container that has since been reclaimed). If so, it needs to
   be pushed here before anything else happens, and the Implementation
   Plan's Phase 0 is the correct next step.
2. **The code never existed** and the documents describe an intended
   build in the past tense. This is consistent with the Implementation
   Plan's own admission of "the last several rebuild cycles… a
   delivery-mechanism failure." If so, this is a greenfield build and
   Phase 0 is moot.
3. **The code existed and was lost.** Functionally identical to (2) for
   planning purposes.

Everything below is written to be correct under either (2) or (3) —
i.e. treating this as greenfield — while flagging what changes if (1)
turns out to be true. **This is blocking question #1.**

---

## 1. Feature Summary — What the Documentation Actually Specifies

### 1.1 The product thesis

Tanzania has 800+ registered Tier II Microfinance Service Providers. Each
is legally required to submit 10 quarterly forms (MSP2-01 … MSP2-10) to
the Bank of Tanzania via its EDI system. Today that is a ~3-day manual
spreadsheet reconciliation per quarter.

The bet: if daily loan operations are captured in a schema that *mirrors
BOT's reporting categories*, the quarterly report becomes an export
rather than a re-derivation. Every other feature exists to get real
operational data into the system so the export has something to compile.

This is a **compliance product first, a loan management system second.**
That ordering matters for every prioritisation decision below.

### 1.2 Documented functional scope

| Domain | Specified behaviour |
|---|---|
| **Auth** | Email/password (Supabase Auth). Signup is 2-step and auto-provisions one institution + one admin user via a `handle_new_user()` trigger on `auth.users`. Email verification required. Password reset exists. |
| **RBAC** | Exactly two roles: `admin`, `officer`. Enforced at the **database layer** via Postgres RLS reading a JWT custom claim, not merely hidden in UI. Officers: create clients/loans/payments; cannot see reports or settings. |
| **Multi-tenancy** | Single shared Postgres. `institution_id` on every table + RLS `USING (institution_id = current_institution_id())`. No schema-per-tenant. |
| **Clients** | CRUD. Auto code `MFI-{year}-{seq}`. Tanzania district/region/sector taxonomy. Gender male/female only (BOT form constraint). Soft deactivation, not deletion. |
| **Loans** | Creation with two interest methods (flat, reducing balance). Server-generated full repayment schedule. Auto code `LN-{year}-{seq}`. BOT 5-tier overdue classification (current / esm / substandard / doubtful / loss) recalculated by a scheduled Postgres function. Statuses: active, completed, written_off. |
| **Payments** | Recorded via Edge Function. Server refetches true `outstanding_balance` — never trusts client input. Allocation is **interest-first, principal-second**. `balance_before`/`balance_after` snapshotted per payment. Append-only: no UPDATE/DELETE RLS policy for any role. |
| **Expenses / Income** | Single dual-purpose table discriminated by `entry_type`, scoped to (institution, quarter, year). Feeds MSP2-02. |
| **Complaints** | Scoped by date received, 6 DB-constrained BOT categories. Feeds MSP2-06. |
| **BOT reporting** | Quarterly compilation of **7 of 10** forms (01, 02, 03, 04, 05, 06, 09), exported to `.xlsx` client-side. 01 and 05 are partially stubbed. |
| **Settings** | Institution profile, team list, password change, data export, subscription status display (a manually-set flag; no billing integration). |
| **Client platform** | Mobile-first React PWA, installable, static-asset caching only — **not** offline-capable for data. |

### 1.3 Documented non-functional scope

- **Availability** is entirely Supabase's; free tier pauses after 7 days
  idle and is explicitly disqualified for production.
- **Backup** requires Supabase Pro (~$25/mo); free tier has no guarantee.
- **Security**: RLS is the *only* tenant-isolation layer. No
  application-layer secondary check. A policy syntax bug is a full
  cross-tenant leak.
- **Performance**: never measured. No load testing.
- **Testing**: unit tests for `interestCalculator.ts` only. No E2E, no CI.

### 1.4 Documented pricing

Starter 150,000 TZS/mo (100 clients) · Growth 350,000 (500) ·
Enterprise 600,000 (unlimited). Set on perceived value, never validated.
Zero paying customers.

---

## 2. Missing Requirements

I've split these into three classes, because they need different
responses from you.

### 2.1 Class A — In your build brief, absent from all documentation

Your instructions list ~30 capabilities. The documentation supports
roughly half. These are the ones with **no schema, no API, no UI, and no
business rules anywhere in the six documents** — and several are
*explicitly cut* in PRD §4.2:

| Requested capability | Documentation status | Cost if in scope |
|---|---|---|
| Multi-branch institutions | **Explicitly out of scope** (PRD §4.2). No `branches` table. PRD §7 asks openly whether a third "branch manager" role is even needed. | New table, new FK on clients/loans/users/payments, RLS rewrite, role model change, every report re-aggregated by branch |
| Loan approval workflow | **Explicitly out of scope** (PRD §4.2 — "maker-checker" named and cut). Loans go straight to `active` on creation. | New status machine (`draft → submitted → approved/rejected → disbursed`), approval table, notification hooks, RBAC extension |
| Loan disbursement (as a distinct step) | Not modelled. `disbursement_date` is a plain column set at creation; there is no disbursement event, no cash-out record. | Status machine + ledger entry |
| Savings accounts | Nothing. No table, no interest rules, no transaction model. | Entire subsystem: accounts, transactions, interest accrual, statements |
| Share accounts | Nothing. Not mentioned in any document. | Entire subsystem |
| Guarantor management | Nothing. | Table, linkage, KYC, liability rules |
| Group lending | Nothing. No groups, no joint liability, no group schedules. | Entire subsystem — this is a large domain, not a table |
| **Penalty calculations** | **Nothing.** This is the most consequential gap. There is overdue *classification* (for BOT reporting) but no penalty rate, no penalty accrual, no penalty balance, no penalty allocation in the payment split. | Schema fields, accrual job, payment allocation redesign (penalty→interest→principal), reporting impact |
| Expenses / Income | Partially present — but as a flat quarterly bucket table, **not** an accounting system | See below |
| **Accounting reports** (GL, trial balance, chart of accounts, journals) | **Nothing.** The `expenses` table is a categorised flat list, not double-entry. There is no ledger, no account codes, no journals, no period close. | This is the single largest item on the list. Building real double-entry accounting is comparable in size to everything else combined |
| Notifications | SMS (Africa's Talking) **explicitly cut** (PRD §4.2). No in-app notification table or surface exists. | Channel integration + template system + delivery log |
| **Audit logs** | Table exists in schema; **nothing writes to it.** Zero triggers. "Currently decorative." | Trigger set across every table, or app-layer interceptor; plus an admin UI (also cut) |
| Document uploads | Nothing. Supabase Storage is not used anywhere in the described build. | Storage buckets, RLS on objects, virus/type validation, per-entity attachment table |
| Export to **PDF** | Only `.xlsx` is described. No PDF path anywhere. | Renderer + templates |
| Backup and restore | Delegated wholly to Supabase Pro tier. No in-app restore capability. | Depends on decision below |
| Rate limiting | Not mentioned in any document. Supabase Auth has built-in limits; nothing is described for data endpoints. | Gateway or Edge middleware |
| CSRF protection | Not mentioned. Supabase uses bearer tokens in `Authorization` headers (not cookies), which largely sidesteps classic CSRF — but this must be an explicit, documented decision, not an accident |
| Staff management | Partial — a team list exists in Settings, but **there is no officer invitation flow at all** (Schema §2, PRD §4.2, Plan Phase 4). An admin literally cannot add a second user today |

**This is blocking question #2.** Your instruction "only implement
features that exist in the supplied documentation" and your project-goals
list are in direct conflict. I will not guess which one governs.

### 2.2 Class B — Specified but incomplete inside the documentation itself

- **MSP2-07, MSP2-08, MSP2-10 are unimplemented.** The PRD's entire
  differentiation claim is "all 10 BOT forms"; the delivered figure is 7,
  two of which (01, 05) are partially stubbed. The Implementation Plan
  puts closing this at Phase 1, correctly.
- **MSP2-01 / MSP2-05** need cash and bank balances that exist nowhere in
  the schema. They are stubs, not bugs.
- **No `bank_accounts` table** — blocks 07, and the real fix for 01/05.
- **No branch/geography aggregation** — blocks 10 (though `clients`
  already carries `district`/`region`, so this one is query work, not
  schema work).
- **No resend-verification-email affordance.** If the verification email
  is lost, the only visible recovery path is password reset — a
  different Supabase operation that does not solve the problem.
- **`bot_reports` table exists with an `excel_path` column but is never
  written to.** Report history/re-download was designed and not built.
- **No payment reversal/adjustment feature.** Payments are deliberately
  immutable, which is right — but the *correcting* mechanism (a reversing
  entry) was never built. Today, fixing a mis-keyed payment requires
  direct database intervention, which destroys the audit property the
  immutability was protecting.

### 2.3 Class C — Requirements your brief implies that no document defines

These are business rules I would have to invent, and I won't:

- Penalty rate, grace period, compounding basis, and whether penalties
  accrue on principal only or on total overdue.
- Whether `monthly_rate` permits 0% (schema says `CHECK > 0`, so no
  interest-free loans are representable).
- Loan fees, insurance, processing charges — no fields exist.
- Early-settlement / prepayment rules (a payment exceeding the schedule).
- Overpayment handling (schema `CHECK amount_paid > 0` but no cap).
- Write-off accounting treatment and whether written-off loans can
  receive recoveries.
- Restructuring / rescheduling of an existing loan.
- Data retention period for audit logs and BOT report archives.

---

## 3. Potential Risks

Ranked by expected damage, not likelihood.

### R1 — Money math in JavaScript floats (Critical, and it conflicts with your own instruction)

TRD §5 states rounding is applied per-period via `Math.round()`, and the
schedule generator force-closes residual balance in the final period. All
of this runs in Deno/JS **IEEE-754 doubles**, then is written to Postgres
`NUMERIC(15,2)`.

Your brief says, verbatim: *"Never use floating-point calculations for
money. Use precise decimal values."* The documented implementation
violates this. The force-close trick masks drift in the *schedule total*
but does not make the intermediate arithmetic exact, and it does nothing
for the payment-split path.

**Recommendation (§5.1):** move all money arithmetic into Postgres
`NUMERIC`, or use an arbitrary-precision decimal library in TS. Not both
independently — see R2.

### R2 — Duplicated financial logic across two runtimes (Critical)

TRD §4 is explicit: `calculatePaymentBreakdown` exists in the frontend
purely for preview, and the authoritative copy lives in the Edge
Function. The TRD itself warns: *"If these two implementations drift, the
user-facing preview will lie about what the backend actually records."*

For a regulated lender, a UI that shows a borrower one allocation and
books another is not a cosmetic bug — it is a disclosure problem. Two
implementations of the same rule *will* drift; this is a question of when.

### R3 — No real database transactions on loan creation (Critical)

TRD §4 describes `create-loan` writing the loan row, then the schedule
rows, and on failure **manually deleting** the loan row. That is a
compensating action, not a transaction. A function timeout between the
two writes leaves an orphaned loan with no schedule, no error, and no
recovery. Nothing detects this state.

For a financial ledger, "we usually clean up afterwards" is not an
integrity model.

### R4 — Silent-failure tenancy (Critical)

`institution_id` is injected into the JWT by a Postgres function wired
through Supabase's Custom Access Token Hook, which **must be enabled by
hand in the dashboard**. If it is not, `current_institution_id()` returns
NULL, every RLS policy evaluates false, and the app returns empty data
**with no error**. The TRD calls this "a recurring undiagnosed failure
mode during earlier build sessions." The UX Brief separately notes there
is no visual signal anywhere for stale or missing data.

Two failure modes with the same signature: perfectly functional UI,
silently wrong or empty content.

### R5 — Stale overdue classification (Critical for the compliance thesis)

`update_overdue_classifications()` must run on a schedule. **The
`pg_cron` line in `schema.sql` is commented out.** Unless someone
manually enables the extension and uncomments it, no loan's
classification ever changes after creation. A loan 40 days overdue keeps
reporting "Current" — to the dashboard *and to the Bank of Tanzania*.

This is the worst class of bug in this product: it produces a
confidently-wrong regulatory filing.

### R6 — RLS is the only isolation layer (High)

TRD §7: "There is no application-layer secondary check. A bug in RLS
policy syntax is a full cross-tenant data leak, not a degraded feature."
Single point of failure for the property that most matters in
multi-tenant fintech. No test suite currently proves isolation holds.

### R7 — Race condition in code generation (High)

`client_code`/`loan_code` are computed by parsing the max existing suffix
via `SPLIT_PART` + `CAST … AS INTEGER` inside a BEFORE INSERT trigger.
Two concurrent inserts in the same institution/year can compute the same
next value. The UNIQUE constraint turns this into a user-facing error
rather than corruption — acceptable — but it is untested and will
misbehave under any concurrency at all. Fixable with an advisory lock or
a real sequence table.

### R8 — Audit log is decorative (High — and a regulatory issue)

A microfinance institution under BOT supervision is expected to
demonstrate who changed what and when. The table exists with an RLS
SELECT policy and is empty in every deployment. Your brief requires audit
logging; the documentation confirms it does not function.

### R9 — Immutable payments with no reversal path (High)

Correct instinct, incomplete execution. See §2.2. The current escape
hatch — direct DB intervention — is strictly worse for auditability than
a modelled reversing entry would be.

### R10 — Reporting completeness is unverified against ground truth (High)

Implementation Plan Phase 3 makes this point well and it deserves
repeating: nobody has submitted a generated report to BOT. The forms were
built against the team's *interpretation* of the MSP2 spec. BOT's own
validator is the only real test, and it has never been run. Everything
downstream of "our reading of the form is right" is an assumption.

### R11 — Vendor lock-in, unstress-tested economics (Medium)

RLS policies, the JWT claims hook, Edge Functions, and Storage are all
Supabase-specific. TRD §2 accepts this deliberately but notes it has
never been priced at 800 institutions. Migration cost is real and grows
monotonically.

### R12 — Category enforcement inconsistency (Medium)

`complaints.complaint_type` is DB-constrained to BOT's 6 categories.
Expense/income categories are enforced **client-side only** — a direct
API call inserts an arbitrary string, which then flows into MSP2-02.
Same for `clients.sector` and `loans.loan_type`, both of which feed BOT
forms. The schema documentation notes this inconsistency "was not
deliberately designed as such." Any client-side-only constraint on a
field that feeds a regulatory filing is a data-integrity hole.

### R13 — Subscription status is an unbacked flag (Medium)

No `subscriptions` table, no invoices, no payment integration. Access is
gated on a manually-edited column. Fine for zero customers; it is not a
billing system, and should not be described as one.

### R14 — Process risk: the rebuild loop (Medium, but historically the top cause of loss here)

The Implementation Plan diagnoses it precisely: *"hit a frustrating bug,
declare the codebase broken, regenerate everything, introduce new
inconsistencies in the regeneration, repeat."* The current empty
repository is arguably the terminal state of that loop. Any plan that
does not actively resist restarting will reproduce it.

---

## 4. Suggested Improvements

Ordered by leverage. Each is a recommendation, not a decision taken.

### 4.1 One implementation of money math, in Postgres

Make the database the single authority for all financial arithmetic:
schedule generation, payment allocation, penalty accrual, balance
computation — as `plpgsql`/SQL functions over `NUMERIC`.

- Kills R1 (NUMERIC is exact decimal; no float ever touches money).
- Kills R2 (the frontend preview calls the **same function** read-only
  via RPC instead of reimplementing it — drift becomes structurally
  impossible, not merely discouraged).
- Kills R3 (a function body is a single transaction; loan + schedule
  become atomic for free).

This one change retires three critical risks. If money math must live in
TypeScript instead, then it must use `decimal.js`/`big.js` and be shared
as a single package imported by both runtimes — never copy-pasted.

### 4.2 Bank-grade double-entry ledger, if accounting is in scope

If §2.1's accounting requirement is confirmed in scope, do not extend the
`expenses` table. Introduce a proper chart of accounts + immutable
journal entries where every financial event (disbursement, repayment,
penalty accrual, write-off, expense, income) posts balanced double-entry
lines. Balances become derived, not stored. MSP2-01/02/05 then compile
from the ledger instead of from stubs — which incidentally closes two of
the three reporting gaps as a side effect.

This is the correct enterprise approach and I'd recommend it — but it is
also the single largest item on the list and it is not in any document.

### 4.3 Health-check on tenancy resolution at boot

Directly from Implementation Plan Phase 2: on app load, run one query
that can only succeed if `current_institution_id()` resolves, and show a
hard blocking error if it doesn't. Turns R4 from a silent
data-disappearance into a legible failure. Cheap, high value.

### 4.4 Freshness as a first-class UI concept

Store `classifications_updated_at`. If it is stale (> 24h), badge every
overdue classification in the UI and **block BOT report generation** with
an explicit warning. Turns R5 from a silent wrong filing into a refusal
to file. The UX Brief §5 identifies exactly this gap.

### 4.5 Cross-tenant isolation as an automated test suite

Not a code review — a test suite. For every table, assert that a user in
institution A cannot SELECT/INSERT/UPDATE/DELETE a row in institution B,
run on every commit. This is the only way R6 stops being a standing
single point of failure.

### 4.6 Audit logging via generic triggers, not hand-written per table

One `audit_row_change()` trigger function attached to every business
table, capturing actor, timestamp, table, row id, and a before/after
JSONB diff. Populates the existing table without touching application
code and cannot be forgotten when a new write path is added — which is
exactly how the current gap arose.

### 4.7 Move BOT report generation server-side

Generation is currently 100% in the browser, and `bot_reports.excel_path`
implies it was meant not to be. Server-side generation gives you an
immutable archive of what was actually filed, re-download, a submission
audit trail, and no dependency on the filer's device. For a compliance
product, the archive is arguably as valuable as the report.

### 4.8 Close the officer invitation gap before anything else user-facing

An admin cannot add a second user. This makes the product single-user in
practice, which contradicts the entire officer persona in PRD §3 and
every officer-facing flow in the App Flow. It is a small piece of work
gating a large share of the value.

### 4.9 CI from commit one

`tsc --noEmit`, lint, unit tests, RLS isolation tests, and a migration
dry-run on every push. TRD §8 lists "no automated CI" as debt; given R14,
CI is also the structural defence against the rebuild loop — it makes
"is it broken?" a question with an automatic answer instead of a vibe.

### 4.10 Model penalties and reversals explicitly, or document their absence

Whichever way §2.3 resolves, the answer belongs in the schema and the
PRD. Silent absence is how MSP2-07/08/10 became a surprise.

---

## 5. Proposed Architecture

Presented as options because the right answer depends entirely on the
scope decision in §2.1. I have a recommendation for each branch.

### Option A — Supabase-native, hardened (fits documented scope)

Keeps the documented stack. React 18 + TS + Vite + Tailwind + TanStack
Query + Zustand on the client; Supabase Postgres + Auth + Edge Functions
+ Storage on the server. Changes from the documented build:

- All money math in Postgres functions (§4.1), called by RPC from both
  the Edge Functions and the preview UI.
- Real transactions everywhere, since logic lives in function bodies.
- Generic audit triggers (§4.6).
- `pg_cron` enabled and asserted, plus freshness gating (§4.4).
- Boot health check for tenancy (§4.3).
- RLS isolation test suite in CI (§4.5).
- Shared form primitives relocated to `shared/` (UX Brief §3 smell).

**Good for:** documented scope + the three missing BOT forms + the
Class B gaps. Fastest path to a real customer. Lowest operational cost.
**Bad for:** the Class A enterprise list. Edge Functions are a poor
home for a double-entry ledger, group lending, or an approval workflow
engine.

### Option B — Layered API over Postgres (fits your full brief) — **recommended if Class A is in scope**

```
┌─────────────────────────────────────────────────────────┐
│  Presentation    React + TS + Vite. No business logic.  │
│                  Feature modules, shared/ui, shared/lib │
├─────────────────────────────────────────────────────────┤
│  API             NestJS (or Fastify + tsyringe)         │
│                  Controllers → DTO validation (zod)     │
│                  → Guards (authn/authz) → rate limiting │
├─────────────────────────────────────────────────────────┤
│  Application     Use-cases / services. One per business │
│                  operation. Transaction boundaries here.│
│                  Depends on ports, not implementations. │
├─────────────────────────────────────────────────────────┤
│  Domain          Entities, value objects (Money, Rate,  │
│                  Term), invariants, domain events.      │
│                  Zero framework imports. Pure TS.       │
├─────────────────────────────────────────────────────────┤
│  Infrastructure  Postgres repositories, ledger, storage,│
│                  notifications, PDF/Excel renderers,    │
│                  audit sink. Implements domain ports.   │
└─────────────────────────────────────────────────────────┘
```

- **Clean architecture / SOLID:** dependencies point inward only. Domain
  has no imports from infrastructure. Repositories are interfaces defined
  in the domain, implemented in infrastructure — this is what makes the
  ledger and the loan engine unit-testable without a database.
- **Money:** a `Money` value object over `decimal.js` at the domain
  boundary, `NUMERIC(15,2)` at rest, with all posting arithmetic executed
  inside Postgres transactions. Never a float, never two implementations.
- **Transactions:** explicit unit-of-work per use case. Loan creation
  writes loan + schedule + ledger entries or writes nothing.
- **Tenancy:** defence in depth — RLS *and* an application-layer tenant
  guard on every query. R6 stops being a single point of failure.
- **Authorization:** a policy layer (role + branch + resource), replacing
  the current "check `role === 'admin'` inline in the page" pattern.
- **Audit:** an interceptor at the use-case boundary *plus* DB triggers.
- **Security:** helmet, strict CORS, zod validation on every boundary,
  per-IP and per-user rate limiting, argon2id password hashing if auth is
  self-hosted, short-lived access tokens + rotating refresh tokens,
  signed upload URLs with MIME/size/extension allowlists and content
  sniffing.
- **Performance:** keyset pagination on all lists, explicit indexes per
  access path, Redis for read-heavy dashboard aggregates and rate-limit
  counters, no N+1 by construction (repositories return aggregates).

Postgres stays; Supabase can remain the host (Option B works fine against
a Supabase-managed Postgres, using it as a database rather than as a
backend) or move to any managed Postgres. That preserves optionality
against R11.

**Good for:** everything in your brief. Real transactions, real ledger,
real workflow engine, testable domain.
**Bad for:** it is meaningfully more infrastructure than a solo developer
with zero customers currently operates, and it delays the first BOT
filing. That tradeoff is yours, not mine.

### Option C — Full custom (Postgres + NestJS + self-hosted auth)

Only worth it if Supabase Auth's constraints become blocking. No evidence
in the documents that they are. **Not recommended.**

### Cross-cutting decisions I would make either way

| Concern | Decision |
|---|---|
| Money at rest | `NUMERIC(15,2)`; never `float`/`double`/JS number |
| Money in code | Decimal library or Postgres-side arithmetic; single implementation |
| Rounding | Half-up, per-period, with terminal-period residual close; documented and unit-tested against fixed vectors |
| IDs | UUID v7 (time-ordered — better index locality than v4) |
| Sequential codes | Real sequence/advisory lock, not `SPLIT_PART` on max (R7) |
| Migrations | Versioned, forward-only, reviewed, run in CI |
| Time | `TIMESTAMPTZ` everywhere; Africa/Dar_es_Salaam only at the presentation edge |
| Soft delete | Status columns, never physical deletes on financial entities |
| Testing | Domain unit tests (financial vectors), integration tests per use case, RLS isolation suite, E2E on the five core flows |

---

## 6. Documentation Conflicts Requiring Your Decision

Per your instruction to stop and ask rather than assume:

1. **Empty repository vs. "78 verified files."** Does the code exist
   somewhere, or is this greenfield? (§0)
2. **Your feature list vs. "only implement what's documented."** ~15
   capabilities in your project goals have no documentation, and several
   are *explicitly cut* in PRD §4.2. Which governs? (§2.1)
3. **"Never use floating point" vs. TRD §5**, which specifies JS
   `Math.round()` on doubles. Confirm the Postgres/decimal approach in
   §4.1. (R1)
4. **Penalty calculations are in your brief and in no document.** No
   rate, grace period, accrual basis, or allocation order exists.
   Undefined = unbuildable. (§2.3)
5. **Accounting reports** in your brief mean either (a) the existing flat
   expense/income summary, or (b) real double-entry with a chart of
   accounts. These differ by an order of magnitude in effort. Which?
6. **Backup and restore** — is Supabase Pro's automated backup
   sufficient, or do you need in-app institution-level export/restore?
7. **BOT MSP2-08 (Agent Banking)** — the Implementation Plan says do not
   build speculatively; confirm with a real MFI whether agent banking is
   even used. Has that confirmation happened?

---

## 7. Recommended Sequence (subject to the answers above)

Assuming greenfield and documented-scope-first:

- **Stage 0** — Repository foundation: monorepo layout, TypeScript
  strict, lint, CI, migration tooling. No features.
- **Stage 1** — Schema + RLS + tenancy, with the isolation test suite
  green before any UI exists. Boot health check (§4.3).
- **Stage 2** — Financial core: `Money`, interest engines, schedule
  generation, payment allocation, all with fixed test vectors. Single
  implementation (§4.1). This is the part that must be right.
- **Stage 3** — Auth, RBAC, **officer invitation** (§4.8), audit triggers
  (§4.6).
- **Stage 4** — Clients → Loans → Payments, the core operational loop.
- **Stage 5** — Expenses/income, complaints.
- **Stage 6** — BOT compilation: the 7 working forms, then 10 (§2.2),
  server-side generation + archive (§4.7).
- **Stage 7** — Dashboard, freshness gating (§4.4), exports.
- **Stage 8** — Anything from Class A that survives the scope decision.

Every stage ends with tests run, build verified, and a written summary of
what changed — per your workflow requirement.

---

## 8. Recommendation Summary

1. Resolve §0 before anything else. It determines whether this is a
   rescue or a build.
2. Cut Class A scope hard for v1, or accept a materially longer timeline
   and a delayed first filing. Do not attempt both.
3. Move money math into one place — Postgres — and retire R1, R2, and R3
   in a single decision.
4. Treat the two silent-failure modes (R4, R5) as launch blockers. A
   compliance product that quietly files wrong numbers is worse than one
   that visibly refuses to file.
5. Build the RLS isolation suite before the first feature, not after the
   first incident.
6. Ship the 10 forms to one real institution and get a real BOT
   acceptance before building anything in Class A. The Implementation
   Plan is right that BOT's validator is the only ground truth that
   exists.

**No code will be written until you approve the architecture and answer
the conflicts in §6.**
