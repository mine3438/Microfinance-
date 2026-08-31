# Requirements decision register

Every requirement this system cannot implement because nobody has decided it
yet, with a stable identifier so it can be referred to in a commit message, a
code comment, a board paper or an email to the Bank of Tanzania.

**Nothing here has been answered by guesswork.** Where the system must behave
somehow while a question is open, the "current behaviour" column records what it
does, and in every case that is the conservative option: refuse the operation,
or record the fact and leave it visible. A guess on a lending system does not
announce itself — it shows up months later as a borrower's balance that is wrong
for a reason nobody chose.

`03-STATUS.md` carries the long-form explanation of each item. This page is the
index.

---

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **DECIDED + IMPLEMENTED** | Decision received, and the behaviour is built and tested. |
| **DECIDED + IMPLEMENTATION PENDING** | Decision received and recorded here; the code does not yet do it. The old safe behaviour still stands in the meantime. |
| **DECIDED (policy recorded)** | Decision received and recorded here, and deliberately not built — because another entry blocks it. Not the same as pending: there is nothing waiting to be written, only a question waiting to be answered. |
| **NOT APPLICABLE** | The institution does not do this. Nothing is built, and nothing needs to be. |
| **BLOCKED BY BOT** | Waiting on a Bank of Tanzania interpretation. No code guesses at it. |
| **BLOCKED BY ACCOUNTING POLICY** | The business rule is decided; the journal/ledger mapping is not. The domain record exists and carries enough to post correctly once the mapping is approved. |
| **DEFERRED** | Could be implemented; deliberately is not. A design decision, not a gap. |

Nothing moves out of a BLOCKED status by inference or by the passage of time —
only on a decision from somebody with the authority to make it, recorded below
with what it was.

---

## Register

| ID | Requirement | Status | Current behaviour | Outstanding |
| --- | --- | --- | --- | --- |
| SHARES-01 | Share par value | NOT APPLICABLE | No shares product exists or will | — |
| SHARES-02 | Subscription rules | NOT APPLICABLE | No shares product exists or will | — |
| SHARES-03 | Transferability | NOT APPLICABLE | No shares product exists or will | — |
| SHARES-04 | Dividend declaration | NOT APPLICABLE | No shares product exists or will | — |
| SHARES-05 | Withdrawability | NOT APPLICABLE | No shares product exists or will | — |
| SHARES-06 | BOT MSP2-01 treatment of shares | DECIDED + IMPLEMENTED | MSP2-01 capital lines are fed by the statements module and report `0` where nil; no customer-share activity is fabricated | — |
| GROUP-01 | Joint or several liability | DECIDED (policy recorded) | Joint. Groups and membership are built; lending to a group waits on GROUP-05 | Implementation pending with GROUP-05 |
| GROUP-02 | Disbursement to group or to members | DECIDED (policy recorded) | One disbursement to the group | Implementation pending with GROUP-05 |
| GROUP-03 | Group guarantee rules | DECIDED (policy recorded) | Members jointly bear the whole obligation | Implementation pending with GROUP-05 |
| GROUP-04 | Default handling for a group loan | DECIDED (policy recorded) | Arrears and classification at group-loan level | Implementation pending with GROUP-05 |
| GROUP-05 | How a group loan is reported on MSP2-03, 09 and 10 | BLOCKED BY BOT | Groups and membership exist; `loans` is untouched, so no group loan can be created | Sector, gender, age band and district for a borrower that is a group |
| GROUP-06 | Groups and membership | DECIDED + IMPLEMENTED | `groups` and `group_members`; membership held as intervals so a past date is answerable | — |
| FEE-01 | What qualifies as a loan fee | DECIDED + IMPLEMENTED | The TZS 5,000 application/form fee, in `loan_application_fees`; the allocator bucket keeps its position and still allocates nil | — |
| FEE-02 | When a fee is charged | DECIDED + IMPLEMENTED | Cash, recorded against an application in draft or pending approval | — |
| FEE-03 | Whether a fee is refundable | DECIDED + IMPLEMENTED | Retained on approval, refund_due on rejection, refunded by stamp that never erases the collection | — |
| FEE-04 | Ledger accounts for collection, retention and refund | BLOCKED BY ACCOUNTING POLICY | Fees are recorded and traceable; no journal entry is posted | Chart-of-accounts mapping |
| FEE-04a | Refund timing where a rejected application is revised and resubmitted | DECIDED + IMPLEMENTED | Charged once per application; a recorded rejection creates entitlement that survives rejected-to-draft and resubmission; at most one refund per collection | — |
| SETTLE-01 | Early-settlement discount | DECIDED + IMPLEMENTED | None. The quote is exactly principal + interest + penalty | — |
| SETTLE-02 | Future-interest treatment on settlement | DECIDED + IMPLEMENTED | Interest through the settlement month; later months never charged, and reported as `interestNotCharged` | — |
| SETTLE-03 | Penalty and fee treatment on settlement | DECIDED + IMPLEMENTED | Every accrued penalty payable, none waived; the application fee is not part of a quote | — |
| SETTLE-04 | Which date governs a settlement figure | DECIDED + IMPLEMENTED | The settlement month. The 1st, 10th and 31st quote identically | — |
| RESTRUCT-01 | Restructuring eligibility and approval | DECIDED + IMPLEMENTED | Permitted only within the original maturity month; `loan.write_off`, held by institution_admin alone | — |
| RESTRUCT-02 | Treatment of principal, interest, penalties, fees | DECIDED + IMPLEMENTED | New principal = remaining principal + unpaid interest + unpaid penalties, computed by the settlement quote so the two cannot disagree | — |
| RESTRUCT-03 | Old schedule handling and new schedule generation | DECIDED + IMPLEMENTED | Old loan moves to `restructured`, keeps its schedule and payments, refuses repayment; successor gets a fresh schedule on the old terms | — |
| RESTRUCT-04 | Accounting treatment of capitalised interest and penalties | BLOCKED BY ACCOUNTING POLICY | Not implemented | Journal mapping for capitalisation |
| RESTRUCT-05 | Whether restructuring resets classification | DECIDED + IMPLEMENTED | The successor starts Current and inherits no delinquency; see the BOT caveat below | — |
| RECOVERY-01 | Treatment of a recovery on a written-off loan | DECIDED + IMPLEMENTED | Recorded in `loan_recoveries`; the loan stays written off, the balance stays zero, and it is never a payment | — |
| RECOVERY-02 | Ledger accounts for recovery income | BLOCKED BY ACCOUNTING POLICY | Recovery records exist and carry amount, date, method and loan | Journal mapping, and wiring MSP2-02 Sno 21 to consume them |
| WRITEOFF-01 | How a loan is written off through the application | DECIDED + IMPLEMENTED | `POST /loans/:id/write-off`, Owner/Manager only, reason required, no automatic threshold | — |
| WRITEOFF-02 | Ledger accounts for a write-off, provided-for versus not | BLOCKED BY ACCOUNTING POLICY | The record keeps principal and penalty separately, so either treatment can be posted later | Journal mapping; BOT distinguishes MSP2-02 Sno 14 from the provision line |
| BOT-FORMAT-01 | Statutory zero values output as `0`, never blank | DECIDED + IMPLEMENTED | `asCellNumber` writes numeric `0` for a zero amount | — |
| BOT-FORMAT-01A | Whether an MSP2-04 rate cell with no lending should be `0` or blank | BLOCKED BY BOT | Left blank — writing `0` would assert lending at 0% | BOT ruling |
| BOT-FORMAT-02 | Monetary figures to the nearest shilling | DECIDED + IMPLEMENTED | Exact decimals written unscaled; an amount a cell cannot hold exactly is refused, never rounded | — |
| BOT-11.2 | Simple or effective annualisation | BLOCKED BY BOT | Explicit parameter, `simple` default, echoed on the form | BOT ruling |
| BOT-11.4 | Age-band reference date | BLOCKED BY BOT | Required argument, never defaulted | BOT ruling |
| BOT-11.5 | Housing loans 0–90 days overdue | BLOCKED BY BOT | Unclassified and surfaced; never Current | BOT ruling |
| BOT-11.8 | Calendar year or the institution fiscal year | BLOCKED BY BOT | Required parameter, echoed as `yearToDateFrom` | BOT ruling |
| BOT-11.8B | Whether a fiscal year must begin on a quarter boundary | BLOCKED BY BOT | Any month 1–12 accepted; a non-aligned year can produce a window over twelve months, reported as it stands | BOT or business |
| RESTRUCT-06 | Whether MSP2-09 counts a restructured facility as a disbursement | BLOCKED BY BOT | The successor carries the restructuring date, so MSP2-09 would count it; no cash moves, so this may overstate lending. The operation is therefore withheld: `RESTRUCTURING_ENABLED` defaults to `false` and the routes are not mounted | BOT ruling |
| AUDIT-01 | Audit retention period | BLOCKED BY BOT | Nothing is ever deleted | BOT requirement |
| IDENTITY-01 | May one person hold accounts at two institutions | BLOCKED BY BUSINESS | Refused; email addresses globally unique | Business decision |
| AUDIT-02 | Audit branch filtering | DEFERRED | No branch on an audit event; no filter offered | Only if an authoritative branch relationship appears |
| AUDIT-03 | Audit date-range index | DEFERRED | No date filter; three existing access paths | Only if a documented query needs it |
| USERS-01 | Role changes on an existing account | DEFERRED | Invitations assign a role; suspension available; no role-change endpoint | Last-administrator rule |

---

---

## Decisions received — 20 August 2026

Recorded in full, including what each item's status was before, so the register
reads as a history rather than a snapshot. Nothing below was inferred; each is
the institution's stated policy, and where a decision leaves an accounting
question open that is recorded too rather than filled in.

### Shares — NOT APPLICABLE

**Previous status.** SHARES-01…05 BLOCKED, awaiting par value, subscription,
transferability, dividends and withdrawability.

**Decision.** The institution is a **sole business**. It does not operate a
member or shareholder shares product: no customer subscriptions, no par value,
no transfers, no dividends, no redemption.

**What this changes.** Nothing is built, and nothing needs to be. The five
questions are not answered — they are *withdrawn*, because the product they
describe does not exist here.

**What it deliberately does not change.** MSP2-01 Sno 52 (Paid-up Ordinary Share
Capital), Sno 53 (Paid-up Preference Shares) and Sno 56 (Share Premium) are the
**institution's own equity capital**, not a customer product. They are entered
through the statements module and continue to report whatever the institution's
accounting data says. A sole business with no customer shares may still have
paid-up capital, and assuming otherwise would understate equity. Where the
figure genuinely is nil, the workbook writes `0` — see BOT-FORMAT-01.

**Extensibility.** MFI Manager is architected for many institutions, so nothing
generic was deleted to record one institution's position. `share.read` and
`share.manage` remain in the permission catalogue, enforcing nothing, exactly as
before. No capability flag was introduced: there is no shares module for a flag
to switch off, and adding a column to `institutions` to describe the absence of
a feature that does not exist would be schema for a capability nobody has — the
fault this project records as R8 and has already had to repair twice.

### Group lending — joint liability, the group is the borrower

**Previous status.** GROUP-01…04 BLOCKED, awaiting the liability model.

**Decision.**

- The **group is the borrower**. Members belong to the group but receive no
  individual sub-loan and no member-level balance.
- Liability is **joint**: members collectively bear the whole obligation.
- **One disbursement**, to the group account. Never split across members.
- **One combined repayment**, one schedule, one balance.
- A partly-paid instalment puts the **whole group loan** in arrears. No member
  is individually overdue.
- Classification is calculated at the **group-loan level**.
- Members stay associated for membership, identification, audit and operational
  management, and membership history must remain interpretable after it changes.

**Status.** DECIDED (policy recorded). The membership half is built (GROUP-06);
lending to a group is not, and waits on GROUP-05 below.

`groups` and `group_members` exist (migrations 0029 and 0030), with membership
held as intervals rather than a roster, and are reachable from the interface: a
group list, a group with its roster read as at any date, add and depart, and the
reverse view of one borrower’s groups. Nothing there touches money.

`loans` is still untouched — no `group_id`, no group borrower, no group
disbursement and no group repayment. A loan to a member of a group remains an
ordinary loan to that borrower, exactly as before. The joint-liability
arithmetic above is decided and recorded but deliberately not built, because
GROUP-05 decides how its result would be reported.

**Extensibility already confirmed.** `loans.client_id` is `NOT NULL` with a
composite key into `clients`. The joint-liability model needs a `groups` table, a
membership table with effective dating, a nullable `group_id` on `loans`, and
`client_id` relaxed to nullable for a loan held by the group itself — all
**additive**. No existing row is rewritten and no constraint is dropped.

### GROUP-05 — how a group loan is reported to BOT

**Status.** BLOCKED BY BOT. Raised while implementing the approved group-lending
model, and it stops the lending half of it.

**What was implemented.** `groups` and `group_members` (GROUP-06), with
membership held as intervals so "who was jointly liable when this was advanced"
stays answerable after people join and leave. `loans` is untouched, so no group
loan can be created and nothing is half-built.

**Why the lending half stopped.** Every MSP2 exposure query reaches a loan's
borrower attributes by inner-joining `clients` on `loans.client_id`:

| Form | What it reads from the borrower |
| --- | --- |
| MSP2-03 | `clients.sector_code` — sectoral classification of the loan book |
| MSP2-09 | `clients.sector_code` and `clients.gender` — disbursements by gender |
| MSP2-10 | `clients.date_of_birth` and district — borrowers by age band |
| MSP2-03 | compulsory savings by sector, and written-off amounts by sector |

Under the approved model the **group is the borrower** and members receive no
sub-loan and no member-level balance. A group therefore has no single sector, no
gender, no date of birth and no district — and no per-member amount to allocate
one from.

A loan with no `client_id` would be **silently excluded** from all of those
queries, because they are inner joins. Not rejected, not flagged: absent. That
understates the loan book on a return filed with the Bank of Tanzania, which is
the same class of failure as R5 — quietly wrong numbers, filed.

**What would have to be invented to proceed.** Any of these, and none is stated
anywhere:

1. **Sector.** Does a group carry its own sector, or is a group loan split
   across the sectors of its members?
2. **Gender.** MSP2-09 splits disbursements by gender. A mixed group has no
   gender. Split by member composition, by count or by amount? Report under one
   heading?
3. **Age band.** MSP2-10 bands borrowers at 35. Same problem, same absence of a
   rule.
4. **Borrower count.** Is a group one borrower on MSP2-10, or as many borrowers
   as it has members?
5. **District.** Members may live in several.

Splitting a group loan across members to answer these would be inventing a
regulatory allocation rule — and it would also contradict GROUP-01, which says
members do **not** receive artificial financial sub-balances.

**Exact decision required.** For each of MSP2-03, MSP2-09 and MSP2-10: how a
loan whose borrower is a group is reported. A ruling from the Bank of Tanzania,
or an authoritative institutional practice they have accepted.

**What happens when it arrives.** The change stays additive: a nullable
`group_id` on `loans`, `client_id` relaxed to nullable, a check that exactly one
is set, and the exposure queries taught to resolve borrower attributes for both
shapes. No existing row is rewritten and no constraint is dropped, which is why
building the entity now costs nothing later.

### Application/form fee — TZS 5,000

**Previous status.** FEE-01…03 BLOCKED, awaiting a definition and a charging
trigger.

**Decision.** Exactly one application-stage charge: **TZS 5,000**, paid in cash
when the applicant submits the loan forms. It is paid separately and is:

- **not** deducted from disbursement;
- **not** added to principal;
- **not** interest-bearing;
- **not** part of the repayment schedule;
- **not** an outstanding balance the repayment allocator can reach.

If the application is **approved** the institution retains it. If **rejected**
it is refunded, and the collection record is kept — a refund is a second event,
never a deletion of the first.

**Status.** DECIDED + IMPLEMENTED, except for the ledger posting (FEE-04).

`loan_application_fees` (migration 0028) records the collection, and a refund is
recorded against it as a second event. The state — `collected`, `retained`,
`refund_due`, `refunded` — is derived by the server from the application and the
refund stamp; it is never stored, and never read off the loan’s current status.
Both collection and refund are reachable from the loan screen.

**What stays true meanwhile, and after.** The allocator's fee bucket keeps its
fixed position and continues to allocate **nil**. The TZS 5,000 never travels
through repayment allocation, so no repayment — past or future — splits
differently because of this decision. Pinned by regression test.

**Accounting caveat — FEE-04, BLOCKED BY ACCOUNTING POLICY.** BOT's MSP2-02
identifies *Fees* under non-interest income as fees charged in day-to-day
operations, which is where a retained application fee plainly belongs. But the
charge is refundable until the application is decided, so between collection and
decision it is not income. No approved chart-of-accounts mapping exists for the
holding, retention and refund entries, so none is invented. The operational
workflow can still record and trace every collection, retention and refund; only
the journal posting waits.

### FEE-04a — the fee is charged once per application

**Previous status.** BLOCKED BY BUSINESS. Raised when the application fee was
built, because the approved refund rule and the existing rejection workflow
disagreed about what "rejected" means.

**The conflict, kept here because it is why the decision was needed.** The rule
said the fee is refunded when an application is rejected. In this system
rejection is not a resting state: migration 0023 moves a rejected application
through `rejected` and on to `draft` in one transaction so the officer can
revise it, and `submit` does not clear the rejection reason. So
`status = 'rejected'` never holds, and "has been rejected" is equally true of a
live, resubmitted application. Any rule reading the status would grant the
entitlement and take it away again as the file moved through the queue.

The first implementation resolved this conservatively — refundable only while
the application sat as a rejected draft — and registered the timing question
rather than answering it.

**Decision.**

> The TZS 5,000 application/form fee is charged once per application. A formal
> rejection makes the collected fee refundable regardless of the application's
> subsequent rejected-to-draft transition. Resubmitting the same application
> does not create another fee. Refunds must never exceed actual fee collections.

**What changed in the code.** The `refund_due` derivation no longer looks at
`loan_status` at all. It keys on the recorded rejection decision, and it is
tested *before* the retained case so that an application rejected once and later
approved keeps the entitlement it earned. The conservative status gate is gone.

**The invariant that makes free resubmission safe.** Because a resubmission
charges nothing, a naive rule would let one collection fund an unbounded number
of refunds:

> 5,000 collected → 5,000 refunded → resubmit free → rejected again → 5,000
> refunded again

That is money from nothing. Two structural facts prevent it. There is at most
one fee row per application, enforced by `loan_application_fees_one_per_loan`;
and a refund is a stamp on that row guarded by `refunded_at IS NULL` on the
write, so a second refund matches no row. Total refunds for an application
therefore cannot exceed total collections, whatever sequence of decisions
happens — asserted directly, summed with `Money`, across a three-cycle test.

**One consequence worth stating.** An application that was rejected once and
later approved still carries the entitlement if nobody refunded it in between.
That follows from the decision as written — eligibility rests on the rejection
decision, not on the current status — and it errs towards the borrower being
paid what a formal rejection entitled them to. It is bounded by the one-refund
invariant, so the institution can never pay out more than it took.

**Still separate: FEE-04.** The ledger mapping for holding, retaining and
refunding the fee remains BLOCKED BY ACCOUNTING POLICY. Collections and refunds
are fully recorded and traceable; no journal entry is posted.

### Early settlement

**Previous status.** SETTLE-01…04 BLOCKED.

**Decision.** A borrower may settle an active loan before maturity, paying:

> outstanding principal + interest due through the settlement month + all
> accrued and outstanding penalties

- **No** early-settlement discount.
- Interest is charged at **month granularity, never prorated by day**. Settling
  on 1, 10 or 31 August all include the whole of August's applicable interest
  and exclude September onwards.
- All penalties already accrued are payable and are **not** waived.
- The TZS 5,000 application fee is **not** part of a settlement quote; it was
  handled at application.

**Status.** DECIDED + IMPLEMENTED.

Settlement is its own operation, which is the whole point of it: an oversized
ordinary repayment would allocate against the *whole* remaining scheduled
interest rather than interest through the settlement month, so it could never
have produced this figure. Ordinary repayments are unchanged.

A quote endpoint returns the four amounts and the interest not charged; taking
the settlement records an ordinary payment row carrying the split and closes the
loan. No migration was needed, because a settlement *is* a payment. The quote is
recomputed on every request and again before anything closes, and the amount
submitted must equal it — so a screen left open produces a refusal rather than a
wrong settlement. The interface quotes, shows the breakdown and confirms; it
computes none of it.

### Restructuring

**Previous status.** RESTRUCT-01…05 BLOCKED.

**Decision.**

- Any borrower may request it, but **only while the original loan is still
  within its originally agreed term**. After the original maturity month has
  passed, this route is unavailable.
- Approval is **Owner/Manager** only, enforced server-side.
- New principal = **remaining principal + unpaid accrued interest + unpaid
  penalties**. Nothing is forgiven. (600,000 + 50,000 + 20,000 = 670,000.)
- A **new loan** is created, reusing the original product's rate and term, with
  a fresh schedule. Interest is charged on the new principal, including the
  capitalised interest and penalties.
- The **old loan is never deleted**, keeps its schedule, stops accepting
  ordinary repayments, and records the link to its successor.
- The new loan starts **Current** and does not inherit the old classification.

**Status.** DECIDED + IMPLEMENTED, and deliberately **not exposed** — see
RESTRUCT-06.

`loan_restructurings` (migration 0031) records the link and the decomposed
amounts carried across, and `restructured` is a loan status of its own so a
restructured loan never reads as a repaid one. The operation is built and
covered by tests.

It is not reachable in production. `RESTRUCTURING_ENABLED` defaults to `false`
and the routes are not registered when it is off, so they answer 404 rather than
403 — absent, not forbidden, because a permission or role change could otherwise
undo the decision without anyone revisiting RESTRUCT-06. There is no
restructuring screen, route or client binding either. The test suite sets the
flag, so the implementation stays proven for the day the ruling arrives.

**Regulatory caveat on RESTRUCT-05.** Starting a restructured loan at Current is
the institution's approved operational policy and is recorded as such. No
supplied BOT document addresses whether a restructured facility may reset its
classification for MSP2-03. If BOT imposes a contradictory treatment, that is a
conflict to surface — not a reason to silently override the approved policy, and
not a licence to assume BOT agrees with it.

**Accounting caveat — RESTRUCT-04, BLOCKED BY ACCOUNTING POLICY.** Capitalising
unpaid interest and penalties into new principal recognises as an asset what was
previously an accrual. The journal entries for that are not established by any
supplied document, so they are not invented.

### Write-off — DECIDED + IMPLEMENTED

**Previous status.** WRITEOFF-01 BLOCKED, and recorded as a defect risk: the
`written_off` status was reachable only by a direct database change.

**Decision.**

- Only the **Owner/Manager** may write a loan off.
- There is **no** days-past-due threshold and **no** scheduled write-off. The
  system may show delinquency to inform the judgement; it must never make it.
- A **reason is required**.
- On write-off: the borrower's live balance becomes **zero**, the loan becomes
  `written_off`, interest and penalty accrual stop, ordinary repayment is
  refused, and the history stays intact — including **the amount written off**,
  which is not erased merely because the live balance is now zero.

**Implemented.** `POST /loans/:id/write-off` behind `loan.write_off`, which only
`institution_admin` holds. Migration 0027 adds `loan_write_offs`: one row per
loan, principal and penalty kept separately, approver, reason and timestamp,
append-only with no UPDATE or DELETE grant.

**Accounting caveat — WRITEOFF-02, BLOCKED BY ACCOUNTING POLICY.** BOT
distinguishes *bad debts written off not provided for* (MSP2-02 Sno 14) from
*provision for bad and doubtful debts*, so not every write-off posts alike. The
record keeps principal and penalty apart precisely so either treatment can be
posted once the mapping is approved. No journal entry is written today.

### Recovery on a written-off loan — DECIDED + IMPLEMENTED

**Previous status.** RECOVERY-01 BLOCKED. Payments against a written-off loan
were refused, which was the safe interim and remains true of *payments*.

**Decision.** Money received after write-off is accepted, and:

- is **not** an ordinary repayment;
- does **not** reinstate the loan or recreate principal;
- does **not** reopen the schedule;
- leaves the loan `written_off` and the live balance at **zero**;
- is recorded separately, may be partial, may happen repeatedly, and is
  individually traceable.

**Implemented.** `POST /loans/:id/recoveries` and `GET /loans/:id/recoveries`.
Migration 0027 adds `loan_recoveries`, append-only, with a database trigger
refusing a recovery against any loan that is not written off.

**Why the separation is structural.** A recovery is not a row in `payments`, so
it cannot move a balance or consume a schedule even by mistake. That is what
stops the same shilling being reported twice — once as interest and principal
through the repayment path, and again as recovery income. Pinned by a test that
asserts a recovery creates no payment row.

**Reporting caveat — RECOVERY-02.** BOT's MSP2-02 Sno 21, *Income from Recovery
of Charged off Assets and Acquired Assets*, expressly includes recovered amounts
previously written off, so that is where these belong. Wiring the compiler to
consume `loan_recoveries` is pending together with the journal mapping, so that
recoveries reach the return exactly once and from one source.

### BOT output format — DECIDED + IMPLEMENTED

**BOT-FORMAT-01.** BOT's general instructions require every statutory item with
a zero value to be filled as zero, with no cell left blank. The workbook writer
already converts an exact decimal to a cell number, so a zero amount is written
as numeric `0`. Verified by test rather than assumed.

**BOT-FORMAT-02.** Figures are reported to the nearest shilling with no scaling
to thousands or millions. The writer emits the exact stored decimal and
**refuses the export** — naming the figure — if a cell could not hold it
exactly, rather than rounding silently. Internal precision is untouched;
`NUMERIC(15,2)` remains the storage.

**BOT-FORMAT-01A — BLOCKED BY BOT, newly raised.** MSP2-04's rate columns are
left blank for a loan type with no lending, because the value is *absent*, not
zero. Writing `0` there would state that the institution lends at 0% interest,
which is false and materially so on a form whose subject is the interest-rate
structure. BOT's "no cell blank" instruction and "do not fabricate" pull in
opposite directions here, so the current behaviour is preserved and the question
is raised rather than settled.


---

## The blocked items, in detail

Kept as written when each was still blocked, because the reasoning is the record
of *why* the question mattered. Where a decision has since arrived it is above,
and the status table is the current position.

### SHARES-01 … SHARES-06 — the shares module

**Questions.** Par value of a share. Subscription rules. Whether shares are
transferable between members. The dividend declaration process. Whether shares
are withdrawable. And BOT's expected treatment on MSP2-01.

**Blocked because** shares are members' capital. Treating a withdrawable share
as permanent capital overstates capital adequacy; declaring a dividend under the
wrong rule distributes money that was not earned. There is no defensible default
for any of the five.

**Current behaviour.** No table, no module, no screen, no arithmetic.
`share.read` and `share.manage` exist in the permission catalogue and enforce
nothing. The MSP2 shares line reports nil, which is *correct* rather than
missing: the institution holds no shares in this system.

**Why that is the safe state.** There is no partial implementation to mislead
anyone and no screen that looks operational. A half-built shares module that
computed a balance would be worse than none, because somebody would believe it.

**To activate.** All five business answers plus SHARES-06. Implementation is
additive — new tables, new module — and needs no change to anything existing.

### GROUP-01 … GROUP-04 — group lending

**Questions.** Is liability fully joint or several? Does a group loan disburse to
the group or to members individually? What are the guarantee rules? How is a
default handled?

**Blocked because** liability decides who owes what after a default, which
decides classification, which decides provisioning, which decides the whole of
MSP2-03 for those loans. The other three answers follow from the first.

**Current behaviour.** No group tables and no group code. A loan to a member of
a group is an ordinary loan to that borrower — accurate under several liability,
and requiring revisiting under joint liability. BOT's loan-type taxonomy already
carries `business_group_loans` and
`business_solidarity_small_group_loans`, so such a loan can be *reported* under a
group heading today; what does not exist is any group entity.

**Extensibility check (asked for, and done).** `loans.client_id` is `NOT NULL`
with a composite foreign key to `(clients.id, institution_id)`. Whichever
liability model is chosen, the implementation is **additive and non-destructive**:

- *Several liability* needs no schema change at all — each member's obligation is
  already an ordinary loan; a `groups` table and a membership table would sit
  alongside for reporting and administration.
- *Joint liability* needs a `groups` table plus a nullable `group_id` on `loans`,
  and relaxing `client_id` to nullable for a loan held by the group itself. Both
  are additive changes. No existing row would be rewritten and no existing
  constraint dropped.

Nothing needs to be built now to keep either door open.

### FEE-01 … FEE-03 — loan fees

**Questions.** What qualifies as a fee? When is it charged? Is it refundable?

**Blocked because** a fee is money the borrower owes that is neither interest nor
principal, so it moves both the outstanding balance and the income statement.

**Current behaviour.** The payment allocator has a fee bucket in a **fixed
position** — second, after penalties and before interest — and it allocates nil.

**Why the position matters more than the value.** Introducing the bucket later at
a different point in the order would retrospectively change how every payment
already recorded would have been split. Fixing the position now, while it
allocates nothing, is what makes the eventual answer applicable without
rewriting history. Pinned by test.

**To activate.** A definition and a charging trigger. The bucket is already where
it needs to be.

### SETTLE-01 … SETTLE-04 — early settlement

**Questions.** Does a settlement discount apply? What happens to future interest,
accrued penalties, and fees? Which date governs?

**Blocked because** future-interest treatment alone can change a settlement
figure by the entire remaining interest of the loan.

**Current behaviour.** No settlement endpoint exists. A borrower paying off early
records ordinary repayments, which reduce the balance exactly as they otherwise
would. Nothing is waived and nothing is discounted, because no rule says anything
should be. Money paid beyond everything owed is recorded as `unallocated` rather
than absorbed.

**To activate.** All four. A partial answer produces a partial settlement figure,
which is worse than none.

### RESTRUCT-01 … RESTRUCT-05 — restructuring

**Questions.** Eligibility, approval authority, treatment of principal, interest,
penalties and fees, what becomes of the old schedule, how the new one is
generated, the accounting treatment, the reporting treatment, and whether a
restructured loan resets its classification.

**Blocked because** a restructure rewrites a live loan's schedule. Done without a
rule, it rewrites history.

**Current behaviour.** Nothing exists — no partial workflow that could half-apply
and leave a loan inconsistent. The loan status machine has **no restructured
state and no transition to one**, so a loan cannot enter an unsupported
restructuring state even by accident.

**To activate.** All nine, plus RESTRUCT-05.

### RECOVERY-01 — recoveries on written-off loans

**Question.** Is a recovery on a written-off loan a repayment, separate income,
or a reinstatement of the loan?

**Current behaviour.** A payment against a `written_off` loan is **refused**,
with a message naming the status. `written_off` is terminal in the status
machine — there is no transition out of it. So a recovery cannot be quietly
recorded as an ordinary repayment, which would put money on a return under a
heading nobody chose. Pinned by test.

**What inspecting the accounting layer found, and what it does not settle.**
BOT's own MSP2-02 taxonomy already carries both halves of this:

- Sno 14 — *"4. BAD DEBTS WRITTEN OFF NOT PROVIDED FOR"* (expense)
- Sno 21 — *"e. Income from Recovery of Charged off Assets and Acquired Assets"*
  (income)

The existence of Sno 21 is **evidence that BOT expects a recovery to be reported
as income rather than as a repayment**, and it narrows the question usefully.

It does not close it. It says nothing about whether the loan record is
reinstated, whether the borrower's outstanding balance moves, how a partial
recovery is handled, or what happens to any provision already raised. Those are
the parts an implementation needs, and they are the parts nobody has stated. This
register does not treat the presence of a reporting line as an accounting
instruction.

**To activate.** The accounting treatment, then a dedicated operation — not a
relaxation of the current refusal.

### WRITEOFF-01 — writing a loan off

**Found during this inspection, and not previously recorded.**

There is **no write-off operation in the application**. The `loan.write_off`
permission exists and is used to guard penalty accrual — reasonably, as the only
seeded permission representing authority to change what a borrower owes without
a payment behind it — but no route moves a loan to `written_off`. The status is
reachable only by a direct database change.

**Current behaviour.** A loan cannot be written off through the product. This is
recorded as blocked rather than as a defect because writing a loan off is an
accounting event with a provisioning consequence, and the rules for it — who may
authorise, at what arrears threshold, what happens to accrued interest and
penalties, what provision is released — are as unstated as RECOVERY-01.

**To activate.** The same conversation as RECOVERY-01. The two are one decision.

### BOT-11.2 — annualisation convention

**Question.** Are MSP2-04 rates read as simple (`monthly × 12`) or effective
(`(1 + monthly)¹² − 1`)?

**Why it matters.** At 5% a month the two differ by nearly twenty percentage
points — 60% against 79.59%.

**Current behaviour.** An explicit query parameter, `simple` by default, and the
convention used is **printed on the compiled return**. Tested at domain and API
level, including that the output is deterministic and does not read the clock.

**To activate.** One ruling. The parameter stays either way — it is what makes an
already-filed return re-derivable.

### BOT-11.4 — age-band reference date

**Question.** As at which date is a borrower's age measured for MSP2-10's
demographic bands?

**Current behaviour.** `ageBandAt(dateOfBirth, asAt)` takes the reference date as
a **required** argument, and `compileMsp2_10` requires `asAt`. Nothing defaults
it. The API passes the reporting period's end date — an explicit choice, visible
at the call site.

**Guarded by test.** Compiling the same request under a system clock moved nine
years forward produces identical output, which is what proves no code path
quietly substitutes today's date. A return refiled later cannot silently
disagree with the one on file.

**To activate.** The reference date. The parameter already exists to receive it.

### BOT-11.5 — housing loans under 91 days overdue

**Question.** BOT's housing microfinance provisioning schedule begins at 91 days
and defines no band below it. How should a housing loan 0–90 days overdue be
classified?

**Current behaviour.** Such a loan is **not classified**. `classifyByDaysOverdue`
returns an unclassified result naming the gap and citing §11.5, the loan is
surfaced on its own row in the portfolio view, and it is **never folded into
Current**.

**Why that is the safe state.** Quietly calling it performing would understate
provisions and file a wrong MSP2-03 — the same understatement the classification
freshness gate refuses whole returns over.

**To activate.** A ruling. Until then the gap stays visible, which is the point.

### BOT-11.8 and BOT-11.8B — the year-to-date window

**Questions.** Does MSP2-02's year-to-date column mean the calendar year or the
institution's own fiscal year? And must a fiscal year begin on a quarter
boundary?

**Current behaviour.** Entries are dated rather than bucketed by quarter, so the
same rows aggregate both ways. `compileMsp2_02` takes `fiscalYearStart` as a
**required** parameter, never defaulted, and the window used is reported on the
form as `yearToDateFrom` / `yearToDateTo`. The API exposes
`fiscalYearStartMonth` with January as a *stated* default.

**On BOT-11.8B specifically.** Any month 1–12 is accepted, and the month asked
for is the month in the answer — nothing normalises it to a quarter boundary. A
quarter-aligned fiscal year (January, April, July, October) keeps every
year-to-date window at twelve months or fewer. A non-aligned one makes a quarter
straddle the boundary: a December fiscal year gives Q4 2026 a window from
`2025-12-01` to `2026-12-31`, thirteen months.

That window is **reported as it stands**, not trimmed. Restricting the parameter
to quarter boundaries would be this system deciding that non-aligned fiscal years
are not permitted, which is precisely the unanswered question. Both properties —
the straddle, and the refusal to normalise — are pinned by test across all six
start months the requirement names.

**To activate.** A ruling on the year, plus a statement on whether a fiscal year
must begin on a quarter boundary.

### AUDIT-01 — retention

**Question.** How long must an institution retain its audit trail?

**Current behaviour.** Nothing is ever deleted. No purge job, no archival, no
retention setting. `audit_logs` has no UPDATE or DELETE policy for any role and
no grant that would permit one, so entries cannot be amended or removed even by
the application.

**Why that is the safe state.** Implementing deletion is a one-way door. Records
removed on a schedule this system invented cannot be produced for an inspection
that asks for them.

**To activate.** The retention period. Keeping everything is the safe default and
is the current behaviour.

### IDENTITY-01 — one person, two institutions

**Question.** May one person hold staff accounts at two different institutions?

**What the current schema actually is** (inspected for this register):

- `users.institution_id` is `NOT NULL` — a user row **belongs to** one
  institution.
- `users_email_unique` indexes `lower(email)` with **no tenant predicate** — the
  address is unique across the entire database.
- There is **no separate membership table**. The `users` row *is* the membership:
  identity, tenancy and profile are one record.
- `user_roles` is keyed `(user_id, role_code)` and carries `institution_id`
  only to compose the tenancy foreign key.

So users are simultaneously institution-owned *and* globally identified, and the
two facts are the same column set. Global uniqueness is not incidental — login
resolves an address to one account **before any institution is known**, which is
what lets a person sign in without first naming their employer.

**Current behaviour.** Inviting an address that already has an account anywhere
is refused. Within the institution the refusal is specific. Across institutions
the unique index fires and the generic integrity handler answers `409` — naming
no table, no constraint, no institution and no person.

**Exactly what would change if the answer is yes** (documented, not built):

1. A `memberships` table — `(user_id, institution_id, branch_id, status)` — with
   its own row-level security, taking over what `users.institution_id` means now.
2. `users` loses `institution_id`, becoming pure identity. Every table with a
   composite `(x, institution_id)` foreign key into `users` would need revisiting.
3. Login changes shape. Resolving an address would return *a set of memberships*,
   so either the user chooses an institution after authenticating, or the access
   token carries a membership rather than a user.
4. `Principal` gains a membership identity; `current_user_id()` and every policy
   built on it would need to agree on which one is acting.
5. The audit trail's `actor_user_id` becomes ambiguous without a membership
   reference.

**Why no preparatory schema change is being made now.** The brief asks whether a
non-breaking preparatory change is justified. It is not. A `memberships` table
added before the policy is answered would be a table nothing writes to and
nothing reads — which is the exact fault this project records as R8, and which
it has now had to repair twice (`audit_logs` with no reader, `invitations` with
no writer). Building schema for a capability that does not exist is how those
came about. The migration path above is additive when the answer arrives; there
is nothing to gain by starting it early and a documented failure mode in doing
so.

---

## Deferred items

Design decisions, not gaps. Recorded so they are not repeatedly rediscovered as
if they were oversights.

### AUDIT-02 — branch filtering on audit events

An audit row records a table name, a row identifier and two payloads. It has no
branch. Deriving one would mean guessing which column of which table names a
branch and presenting the guess as a filter.

It is also unnecessary: `audit.read` is held only by `institution_admin` and
`auditor`, both institution-wide, and the policy on `audit_logs` scopes the table
to the institution. Auditing an institution means seeing all of it.

**Revisit when** an authoritative branch relationship exists on the event itself.

### AUDIT-03 — date-range filtering and its index

A date range is expressible — UUIDv7 identifiers carry their timestamp — but no
documented requirement asks for one, and serving it as an index seek rather than
a scan would need a fourth index on a table that grows for the life of the
institution.

The three existing access paths cover what the screen offers: tenant and time,
table and row, and actor. No schema change has been made for a hypothetical
query.

**Revisit when** a documented requirement asks for "what happened between these
two dates".

### USERS-01 — role changes on an existing account

Invitations assign a role; no endpoint changes one afterwards. The no-escalation
check would carry over unchanged, but two further questions would not: may an
administrator demote themselves, and may an institution be left with no
administrator at all?

Suspension sidesteps both. `user.manage` is held only by `institution_admin`, and
nobody may amend their own account — so every caller is an administrator, each
can suspend the others, none can suspend themselves, and at least one active
administrator always remains whatever order the calls arrive in. That derived
property is what makes suspension safe to ship while role changes wait.

**Revisit when** the last-administrator rule is decided. Until then, changing
somebody's role means withdrawing their invitation and issuing another.

---

## Changing this register

An item moves to **ANSWERED** only when somebody with the authority to decide it
has done so, in writing, and the answer has been implemented and tested. Nothing
here is closed by inference, by a plausible default, or by the passage of time.
