# MFI Manager — implementation status

What works, what is deliberately not built, and what is waiting on somebody
else's decision. One page, so the three are never confused for one another.

The distinction matters more here than on most systems. This is software that
moves real money for institutions under Bank of Tanzania supervision, and the
difference between "we chose not to build this" and "nobody has told us the
rule" is the difference between a gap and a guess. A guess in a lending system
does not announce itself: it shows up as a borrower's balance that is wrong for
a reason nobody decided.

Companion to `01-ARCHITECTURE.md`, which explains *how* each implemented thing
works and why. This page says only whether it exists.

`04-DECISION-REGISTER.md` carries the same blocked items under stable
identifiers — `SHARES-01`, `BOT-11.5`, `IDENTITY-01` and so on — so a question
can be cited in a commit message, a board paper or an email to the Bank of
Tanzania. `OPEN-QUESTIONS.pdf` is the register rendered for people who do not
read Markdown in a terminal; regenerate it with
`node scripts/generate-open-questions-pdf.mjs`.

---

## 1. Implemented

Fully operational, tested, and reachable from the interface.

| Area | What an institution can do |
| --- | --- |
| **Authentication** | Sign in, rotate refresh tokens with reuse detection, sign out. Argon2 passwords, HS256 access tokens, uniform timing on unknown addresses. |
| **Authorisation** | Five roles, thirty permissions, enforced at the route *and* by row-level security. Branch scoping for branch-assigned staff. |
| **Staff management** | Invite staff, withdraw an invitation, accept one and set a password, list staff, suspend and restore. See §4 for how invitations are delivered. |
| **Borrowers** | Register, amend, deactivate, search, page. District and sector chosen from BOT's published lists. |
| **Branches** | Create, amend, relocate, close. Designate the head office as an atomic operation. |
| **Loan products** | Create, retire. Rate bands, term bands, principal bands, penalty terms. |
| **Loans** | Apply, submit, approve or reject, disburse. Approval thresholds per role; maker–checker enforced. Rejection returns an application to draft. |
| **Repayments** | Record, preview the allocation before recording, reverse with a reason. Allocation order penalties → fees → interest → principal. |
| **Penalties** | Per-product terms, daily accrual with a grace period and optional cap, idempotent by date, runnable as a job or an endpoint. |
| **Savings** | Products, accounts, deposits, withdrawals, reversals. |
| **Classification** | BOT's five classes and provisioning rates, recomputed by a scheduled job, with a staleness gate that refuses to compile a return on stale figures. |
| **Portfolio** | Loan book by classification, non-performing ratio, and how old the figures are. |
| **Finance** | Income and expense entries, bank accounts, balances, financial statements. |
| **Complaints** | Log, resolve by either route, refer onward. MSP2-06 is derived entirely from these dates. |
| **BOT MSP2 reporting** | All ten quarterly forms, eighteen validation rules, Excel and PDF export, filing records. |
| **Audit** | Every change to every business table, written by a database trigger, readable by holders of `audit.read`. |
| **Application fee** | Collect the TZS 5,000 form fee in cash, retain it on approval, refund it on rejection. Charged once per application; the collection record survives the refund. |
| **Early settlement** | Quote a settlement, then take it. Principal + interest through the settlement month + accrued penalties, no discount, future interest never charged. |
| **Write-off** | Owner/Manager writes a loan off with a reason. Balance zeroed, accrual stopped, the amount written off kept. |
| **Recovery** | Record money received after a write-off, without reinstating the loan or recreating principal. |
| **Restructuring** | Roll remaining principal, unpaid interest and unpaid penalties into a successor loan on the original terms. Old loan kept, closed to repayment, linked to its successor. **See §7 before exposing.** |
| **Groups** | Create groups, manage membership as intervals, read a roster or a borrower's groups as at any date. Group *lending* is blocked — see §7. |

---

## 2. Blocked — awaiting a business or regulatory decision

> **Several subsections below have since been decided and built.** They are kept
> as written, because the reasoning is the record of why each question mattered
> and what the system did while it was open. `04-DECISION-REGISTER.md` is the
> current position; where the two differ, the register is right.
>
> Superseded here: **2.2** group lending (decided; membership built, lending
> still blocked on GROUP-05), **2.3** loan fees (decided and built), **2.4**
> early settlement (decided and built), **2.5** restructuring (decided and
> built), **2.6** recoveries (decided and built), and **2.1** shares (withdrawn
> as not applicable).

**Nothing in this section is implemented, and nothing in it is guessed.** Where
the system must do *something*, the current behaviour is stated, and in every
case it is the conservative option: refuse, or record and leave visible.

### 2.1 Shares — §13.5

**The question.** Par value, subscription rules, transferability, the dividend
declaration process, and whether shares are withdrawable.

**Why it matters.** Shares are members' capital. Getting withdrawability wrong
misstates capital adequacy; getting dividends wrong distributes money that was
not earned.

**What it blocks.** `share.read` and `share.manage` enforce nothing. There is no
shares table, no shares module and no shares screen.

**Current behaviour.** Nothing exists — which is the safe state. There is no
partial implementation to mislead anyone, no screen that looks operational, and
no arithmetic producing a share balance that has no rule behind it. The MSP2
shares line reports nil, correctly, because the institution holds no shares in
this system.

**To unblock.** Answers to all five questions above, plus BOT's expected
treatment on MSP2-01.

### 2.2 Group lending — §13.6

**The question.** Joint versus several liability; whether a group loan disburses
to the group or to members individually; group guarantee rules; default
handling.

**Why it matters.** Liability decides who owes what after a default, which
decides classification, provisioning and the whole of MSP2-03 for those loans.

**What it blocks.** Groups entirely. `business_group_loans` and
`business_solidarity_small_group_loans` exist in BOT's loan-type taxonomy, so a
loan can already be *reported* under a group heading; what does not exist is any
group entity, membership, or joint-liability arithmetic.

**Current behaviour.** No group tables and no group code. A loan to a member of a
group is an ordinary loan to that borrower, which is accurate under several
liability and would need revisiting under joint liability.

**To unblock.** The liability model first — the other three follow from it.

### 2.3 Loan fees — §13.8

**The question.** What qualifies as a fee, when it is charged, whether it is
refundable, and how it interacts with settlement.

**Why it matters.** A fee is money the borrower owes that is not interest and
not principal, so it changes both the balance and the income statement.

**What it blocks.** Fee accrual. Nothing charges a fee.

**Current behaviour.** The allocator has a fee bucket in a **fixed position** —
second, after penalties and before interest — and it allocates nil. The position
is deliberate and must not move: introducing the bucket later, at a different
point in the order, would retrospectively change how every payment already
recorded would have been split. Pinned by test.

**To unblock.** A definition of a fee and a charging trigger. The bucket is
already where it needs to be.

### 2.4 Early settlement — §13.8

**The question.** Whether a settlement discount applies; what happens to future
interest, to accrued penalties, and to fees; and what date governs.

**Why it matters.** Future-interest treatment alone can change a settlement
figure by the whole remaining interest of the loan.

**What it blocks.** Any "settle this loan today" operation.

**Current behaviour.** No settlement endpoint exists. A borrower who wants to pay
off early records ordinary repayments, which reduce the balance exactly as they
would otherwise; nothing is waived and nothing is discounted, because no rule
says anything should be. Overpayment beyond everything owed is recorded as
`unallocated` rather than absorbed.

**To unblock.** All five questions. Partial answers produce a partial settlement
figure, which is worse than none.

### 2.5 Restructuring — §13.8

**The question.** Eligibility, approval authority, and the treatment of accrued
interest, penalties, fees and outstanding principal; what happens to the old
schedule; how the new one is generated; the accounting treatment; the reporting
treatment.

**Why it matters.** A restructure rewrites a live loan's schedule. Done without a
rule it silently rewrites history.

**What it blocks.** Any restructure operation.

**Current behaviour.** None exists — no partial workflow, no draft schedule
regeneration, nothing that could half-apply and leave a loan inconsistent. The
loan status machine has no restructured state and no transition to one.

**To unblock.** All nine, and BOT's view on whether a restructured loan resets
its classification.

### 2.6 Recoveries on written-off loans — §13.8

**The question.** Whether a recovery is a repayment, separate income, or a
reinstatement of the loan.

**Why it matters.** It decides which line of MSP2-02 the money appears on, and
whether the loan returns to the book.

**What it blocks.** Recording a recovery.

**Current behaviour.** A payment against a `written_off` loan is **refused** with
a message naming the status. `written_off` is terminal in the status machine —
there is no transition out of it. So a recovery cannot be quietly recorded as an
ordinary repayment, which is the outcome that would put money on a return under
a heading nobody chose. Pinned by test.

**To unblock.** The accounting treatment, then a dedicated operation. Not a
relaxation of the current refusal.

### 2.7 Rate annualisation — §11.2

**The question.** Does BOT read MSP2-04's rates as simple (`monthly × 12`) or
effective (`(1 + monthly)¹² − 1`)?

**Why it matters.** At 5% a month the two differ by nearly twenty percentage
points — 60% against 79.59%.

**Current behaviour.** `annualisation` is an explicit query parameter, `simple`
by default, and **the convention actually used is printed on the compiled form**.
The choice is visible on the filed return rather than buried in the compiler.
Covered by tests at both the domain and API level.

**To unblock.** One answer from BOT. The parameter stays either way — it is what
makes the answer auditable.

### 2.8 Age-band reference date — §11.4

**The question.** As at which date is a borrower's age measured for MSP2-10's
demographic bands?

**Current behaviour.** `ageBandAt` takes the reference date as a **required**
argument. Nothing defaults it, so no caller can accidentally measure age as at
today when the return is for a quarter that ended months ago.

**To unblock.** The reference date. The parameter already exists to receive it.

### 2.9 Housing loans, 0–90 days overdue — §11.5

**The question — for BOT, not for the institution.** BOT's housing microfinance
provisioning schedule begins at 91 days and defines no band below it. What
should a housing loan 0–90 days overdue be classified as?

**Current behaviour — read this carefully, it is easy to misremember.** Such a
loan is **not classified at all**. `classifyByDaysOverdue` returns an
unclassified result naming the gap, the loan is surfaced on its own row, and it
is **never folded into Current**. Quietly calling it performing would understate
provisions and file a wrong MSP2-03 — the same understatement the classification
gate refuses a return over.

**To unblock.** BOT's ruling. Until then the gap is visible, which is the point.

### 2.10 Fiscal year for year-to-date — §11.8

**The question.** Does MSP2-02's year-to-date column mean the calendar year or
the institution's own fiscal year?

**Current behaviour.** Entries are dated rather than bucketed by quarter, so the
same rows aggregate both ways. `compileMsp2_02` takes `fiscalYearStart` as a
**required** parameter — never defaulted — and the window used comes back on the
compiled form. The API exposes `fiscalYearStartMonth` with January as a *stated*
default. Boundary derivation is covered by tests, including non-calendar and
mid-quarter start months.

**A related question this pass surfaced, also unanswered.**
`fiscalYearStartMonth` accepts any month 1–12, and a quarter is placed by the
fiscal year its **first month** falls in. For a fiscal year that begins on a
quarter boundary (January, April, July, October) every quarter sits wholly
inside one fiscal year and the year-to-date window is never longer than twelve
months.

For a start month that does **not** begin a quarter — December, say — one
quarter straddles the boundary, and the year-to-date window for it runs longer
than a year: Q4 2026 with a December fiscal year gives `2025-12-01` through
`2026-12-31`, thirteen months.

This is left exactly as it is, and pinned by test. Changing it would mean
choosing a rule for non-aligned fiscal years that no supplied document states,
and the window actually used is reported on the form as `yearToDateFrom`, so it
is visible rather than implied. Whether an institution may declare such a fiscal
year at all is part of the same §11.8 question.

**To unblock.** One answer, plus a note on whether a fiscal year must begin on a
quarter boundary. The plumbing is already explicit.

### 2.11 Audit retention

**The question.** How long must an institution keep its audit trail?

**Current behaviour.** Nothing is ever deleted. There is no purge job, no
archival, no retention setting. `audit_logs` has no UPDATE or DELETE policy for
any role and no grant that would permit one, so entries cannot be amended or
removed even by the application.

**To unblock.** BOT's retention period. Note that implementing deletion is a
one-way door: the safe default is to keep everything, and it is the current
behaviour.

### 2.12 Cross-institution staff identity

**The question — surfaced by building invitations.** May one person hold accounts
at two institutions?

**Why it matters.** `users_email_unique` indexes `lower(email)` **globally**,
because login identifies a user before any institution is known. So an address
belongs to exactly one institution, for all time.

**Current behaviour.** Inviting an address that already has an account anywhere is
refused.

Within the institution the refusal is specific and useful — "that email address
already belongs to a member of staff here". Across institutions the unique index
fires and the generic integrity handler answers `409` with *"That record already
exists. Check whether it has been entered before."* — which names no table, no
constraint, no institution, no person and no status. The constraint name goes to
the log with the correlation ID rather than to the caller.

It is still an oracle: a `409` tells the caller the address is in use
*somewhere*. That is unavoidable while login must resolve an address to one
account before any institution is known. It is bounded by `user.invite` and by
the rate limiter, and it discloses nothing beyond existence.

**To unblock.** If the answer is yes, this needs a membership table separating
identity from institution — a schema change and a login change, not a tweak.
Recorded here because it is a real limit somebody will meet.

---

## 3. Deliberately deferred

Design decisions, not gaps. Each was considered and declined for a reason.

### 3.1 Audit date-range filter

An audit date range is expressible — UUIDv7 identifiers carry their timestamp —
but no supplied requirement asks for one, and serving it as a seek rather than a
scan would need a fourth index on a table that grows for the life of the
institution. The three existing access paths (tenant and time, table and row,
actor) cover what the screen offers.

**Revisit when** a documented requirement asks for "what happened between these
two dates", at which point the index is justified by the query that needs it.

### 3.2 Audit branch filtering

An audit row records a table name, a row identifier and two payloads. It has no
branch. Deriving one from the payload would mean guessing which column of which
table names a branch, and presenting the guess as a filter.

It is also unnecessary: `audit.read` is held only by `institution_admin` and
`auditor`, both institution-wide roles, and the policy on `audit_logs` scopes the
table to the institution. Auditing an institution means seeing all of it.

**Revisit when** an authoritative branch relationship exists on the event itself.

### 3.3 `isHeadOffice` as an ordinary field

Not deferred any more — **implemented in this pass**, but deliberately *not* as a
field on `PATCH /branches/:id`. Exactly one head office per institution is a
partial unique index, which cannot be declared `DEFERRABLE`. A single
`UPDATE ... SET is_head_office = (id = $2)` over both rows gives no guarantee
about row order, so it fails whenever the new designation is written before the
old one is cleared — intermittently, and depending on data.

`POST /branches/:id/head-office` clears then sets, in one transaction,
serialised on the institution row with `SELECT ... FOR UPDATE` so two concurrent
promotions cannot both clear a stale snapshot. Idempotent, so a retried request
after a dropped response is safe.

### 3.4 Role changes on an existing account

Invitations assign a role; there is no endpoint to change one afterwards.

The no-escalation check would carry over unchanged, but two further questions
would not: may an administrator demote themselves, and may an institution be left
with no administrator at all? Neither is answered by any supplied document.

Suspension avoids both. `user.manage` is held only by `institution_admin`, and
nobody may amend their own account, so at least one active administrator always
remains no matter what order the calls arrive in. That property is what makes
suspension safe to ship while role changes wait.

**Revisit when** the last-administrator rule is decided. Until then, changing
somebody's role means withdrawing their invitation and issuing another, or
seeding directly.

### 3.5 Session issuance on invitation acceptance

Accepting an invitation returns `204` and no session. The invitee signs in.

One code path issues every session in the system, and routing new users through
it means the account they have just created is proved to work before they depend
on it.

---

## 4. Invitation delivery

No supplied document names an email provider, a sending domain, or who pays for
one. Integrating SendGrid, Resend, Mailgun or a bare SMTP host would choose all
three on the institution's behalf, and it is not a reversible choice: it puts a
third party in the path of a credential that creates staff accounts.

So `InvitationDelivery` is an interface with two implementations, neither of
which is a provider.

| `INVITATION_DELIVERY` | Behaviour | Where |
| --- | --- | --- |
| `manual` *(default)* | The API returns the invitation link, once, to the administrator who created it. They convey it. | Anywhere, production included |
| `log` | The link goes to the server log. | Development only — **refused at startup in production** |

`manual` is not a placeholder. For a Tier II provider whose new loan officer is
in the next room it is how the thing actually happens, and it needs no secrets,
no sending domain and no vendor. The token appears in plaintext exactly once, in
a response to an authenticated caller holding `user.invite`, over the same TLS
connection that carried their access token. Only its SHA-256 hash reaches the
database.

`log` is refused in production because a log store is read by more people than an
inbox, kept longer, and often shipped to a third party for search.

**Adding SMTP later** is one class implementing `InvitationDelivery` and one case
in `createInvitationDelivery`. Nothing above the interface changes. Credentials
would come from the environment, as every other secret does; none is committed.

---

## 5. Invitation security

| Property | How |
| --- | --- |
| Token strength | 256 bits from a CSPRNG, base64url |
| Storage | SHA-256 hash only, `UNIQUE`. The token itself is never stored |
| Expiry | Seven days, in the conditional `UPDATE` that consumes the invitation — not in a preceding read |
| Single use | Same predicate. Two requests racing the same token contend on the write; only one can match a row |
| Revocation | `revoked_at`, checked by the same predicate. The row is kept — who was invited, by whom, and that the offer was withdrawn is what an inspection asks about |
| Duplicate prevention | Partial unique index over invitations that are still open |
| Inviter identity | `invited_by`, foreign-keyed to `users` |
| Tenant safety | Institution comes from the inviter's session and is not a request field; row-level security refuses a cross-tenant write regardless |
| Branch safety | A branch-scoped inviter may only invite into their own branch |
| Escalation | A role may only be granted if its permissions are a subset of the granter's, read from `reference.role_permissions` |
| Transport | Token travels in a request body, never a URL — keeping it out of access logs, browser history and `Referer` headers |
| Rate limiting | Acceptance shares login's tier (5/minute, closed when the limiter is unreachable) because it hashes a password with argon2 |
| Audit | Database triggers record the account creation, the invitation, and the acceptance. The acceptance records no actor, because the person accepting has no session — which is the honest entry |

---

## 6. What this pass did not touch

No existing financial calculation, allocation rule, interest or penalty
computation, accounting entry or report output was modified. Migration 0026 adds
a function, a policy and column grants; it alters no data and no existing
column.

No historical financial result can have changed.

---

## 7. What is safe to expose in the interface

A backend operation being complete and tested is not the same as it being safe
to put in front of staff. Two of the domains below reach a Bank of Tanzania
return by a path nobody has ruled on, and one has no operation at all. Exposing
those would let an institution create records it cannot correctly report.

The distinction that matters is **whether using the feature can put a wrong
figure on a filed return, or a figure whose treatment nobody has agreed.**

### Safe to expose

| Domain | Why it is safe |
| --- | --- |
| **Staff invitations** | No financial effect. Creates accounts, nothing else. |
| **Audit trail** | Read-only. |
| **Borrowers, branches, loan products** | Unchanged, and in use. |
| **Loans, repayments, penalties, savings** | Unchanged, and in use. |
| **Groups and membership** | Administrative only. No group can hold a loan, so no group reaches any MSP2 form. |
| **Application fee** | Recorded and traced entirely outside the loan. It never becomes principal, never earns interest, and never enters the repayment allocator, so no return moves when one is collected or refunded. The *ledger posting* is still blocked (FEE-04), but that blocks bookkeeping, not the operational record. |
| **Early settlement** | Closes a loan for a figure computed by the approved rule, recorded as an ordinary payment row. MSP2-02 already sums interest income from payments, so a settlement reports exactly like any other receipt — because that is what it is. |
| **Write-off** | The write-off amount is captured before the balance is zeroed, and MSP2-03's written-off column already reads the domain event this raises. |
| **Recovery** | Recorded in its own table, never as a payment, so it cannot be double-counted as repayment income. |

Two caveats that do **not** block exposure, but should be understood by whoever
turns these on:

- **Write-off and recovery post no ledger entries** (WRITEOFF-02, RECOVERY-02).
  The operational records are complete and carry principal and penalty
  separately, so the eventual treatment can be posted against write-offs that
  have already happened. Until then, bookkeeping for them is manual.
- **The application fee is the same** (FEE-04). Collections and refunds are
  fully traceable; no journal entry is written.

### Must remain disabled

| Domain | Blocker | What goes wrong if exposed |
| --- | --- | --- |
| **Group lending** — lending to a group | **GROUP-05** | There is no endpoint, so this is currently disabled by construction rather than by configuration. Were one added, every MSP2 exposure query reaches a borrower's sector, gender, age and district through `loans.client_id`. A group has none of them, so a group loan would be **silently dropped** from MSP2-03, MSP2-09 and MSP2-10 — understating the loan book on a return filed with BOT. |
| **Restructuring** | **RESTRUCT-06** | The operation is complete and correct at the loan level, but the successor carries a disbursement date, and MSP2-09 counts every loan whose disbursement date falls in the quarter. No cash moves in a restructuring, so each one **may overstate reported disbursements**. Nobody has ruled on whether BOT counts a refinanced facility as a disbursement. |

**Restructuring is the one that needs a deliberate decision before go-live.**
Unlike group lending it is fully built and reachable, so it is disabled only if
somebody chooses to disable it. The safe options, in order of preference:

1. Get the BOT ruling on RESTRUCT-06. It is one question.
2. Withhold the permission until then. Restructuring is guarded by
   `loan.write_off`, which only `institution_admin` holds — so an institution
   can simply not use it, but nothing stops them.
3. Expose it and accept that MSP2-09 will include restructured facilities,
   knowing the `loan_restructurings` link makes them identifiable and
   excludable retrospectively once the ruling arrives.

Option 3 is defensible only if the institution knows it is choosing it. It is
not this system's decision to make on their behalf, which is why nothing here
excludes them automatically.

### The screens, and what they deliberately lack

Five of the six domains now have a web interface: **groups and membership**,
the **application fee and its refund**, **early settlement**, **write-off** and
**recovery**. Each follows the rule above — every authoritative figure is
rendered from the response that carried it, and nothing in the browser
computes a settlement, a balance, a write-off amount or a refund entitlement.

The sixth, restructuring, has no screen, and it is no longer reachable at all.

### How restructuring is withheld

Hiding a button would not have been enough. The endpoints existed and any
holder of `loan.write_off` — every `institution_admin` — could have reached
them with a script or a shell, whatever the interface showed. So the guard is
on the server:

- **`RESTRUCTURING_ENABLED`** is a configuration value that defaults to
  `false`. When it is off, `registerLoanRoutes` returns before it registers
  either restructuring route.
- **Off means absent, not forbidden.** The routes do not exist, so they answer
  404 like any unknown path. A 403 would have meant the operation was there and
  the caller lacked something — which a role edit or a new administrator could
  undo without anyone revisiting RESTRUCT-06.
- **No permission was changed.** `loan.write_off` also governs write-off, which
  is safe to expose; withdrawing it would have disabled both. A test asserts
  write-off still works while restructuring 404s, so that shortcut cannot be
  taken later by accident.
- **The implementation is untouched.** `restructuring.test.ts` runs against a
  harness that sets the flag, so the domain logic stays proven for the day the
  ruling arrives. `safe-refusals.test.ts` covers the production default.
- **The client cannot call it either.** There is no endpoint binding, no route
  and no navigation entry, and `blocked-features.test.tsx` scans the whole
  source tree to keep it that way — a screen added later cannot quietly become
  the first half of exposing it.

Group lending needs no such flag: there is no endpoint to withhold, and the
same source-level test asserts no group identifier ever reaches the loan module.
