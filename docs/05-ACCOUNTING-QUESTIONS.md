# Accounting policy decisions required

**To:** the institution's accountant
**From:** MFI Manager implementation
**Subject:** four business events that are recorded but not posted

Four business events are built, tested and in operational use. Each records what
happened and preserves the underlying figures, but **none posts a journal
entry**, because no approved chart-of-accounts mapping exists for them.

Nothing below proposes a treatment. No account codes are invented. Each question
is asked because the answer cannot be derived from any document supplied to the
project, and guessing it would put a figure in the accounts that nobody decided.

These four are recorded in `04-DECISION-REGISTER.md` as **FEE-04**,
**WRITEOFF-02**, **RECOVERY-02** and **RESTRUCT-04**, all **BLOCKED BY
ACCOUNTING POLICY**. They stay blocked until this document comes back answered.

---

## Two facts about the system that bear on your answers

**1. MSP2-02 is compiled from manually entered finance entries.** Each entry is
keyed to a BOT line number. None of the four events below posts to it
automatically today.

**2. Provisions are not a ledger balance.** The system computes provisioning
rates from BOT's classification schedule for MSP2-03 reporting only. There is no
posted provision account for a write-off to release. If an answer below assumes
one exists, please say what should create it.

Relevant BOT MSP2-02 reporting lines, taken from the MSP2 template supplied by
the product owner (`apps/api/assets/BOT-MSP2-template.xlsx`, described in
`02-BOT-REPORTING-SPEC.md`). Line descriptions are reproduced as they appear:

| Sno | Line |
| --- | --- |
| 14 | 4. BAD DEBTS WRITTEN OFF NOT PROVIDED FOR |
| 15 | 5. PROVISION FOR BAD AND DOUBTFUL DEBTS |
| 18 | b. Fees _(under 6. NON-INTEREST INCOME)_ |
| 21 | e. Income from Recovery of Charged off Assets and Acquired Assets |

---

## FEE-04 — Application/form fee

**Business event.** A TZS 5,000 application fee is collected in cash when a
borrower submits loan forms. It is charged **once per application**, not once per
submission. If the application is approved the institution retains it. If the
application is formally rejected the applicant becomes entitled to a refund, and
a refund is recorded only when staff physically hand the cash back. Revising and
resubmitting the same application never incurs a second fee.

**Example.** A borrower submits forms on 3 February and pays TZS 5,000 in cash.
On 20 February the application is rejected. On 24 February a cashier hands
TZS 5,000 back and records it. The applicant revises and resubmits on 3 March —
no further fee is charged.

**Current system behaviour.** The collection is recorded with date, method,
reference and the staff member who took it. State is derived as `collected` →
`retained` or `refund_due` → `refunded`. A refund is recorded as a second event;
the original collection record is never deleted or amended. No journal entry is
written, and no screen states or implies that one is.

**Accounting decision required.** The fee may later be retained or refunded
depending on the credit decision. Please specify the accounting treatment from
collection through final retention or refund.

| Question | Answer |
| --- | --- |
| Debit account — on collection | `__________` |
| Credit account — on collection | `__________` |
| Debit account — on retention, if a further entry is required | `__________` |
| Credit account — on retention, if a further entry is required | `__________` |
| Debit account — on refund | `__________` |
| Credit account — on refund | `__________` |
| Recognition timing — at which point or points does an entry arise? | `__________` |
| Treatment of any previously recognised balance | `__________` |
| Additional treatment/entry — should MSP2-02 Sno 18 be fed from these records, and on what basis? | `__________` |
| Accountant notes | `__________` |

---

## WRITEOFF-02 — Loan written off

**Business event.** An owner or manager judges a debt no longer realistically
recoverable and writes it off. There is no automatic days-overdue trigger — it is
always a person's decision, with a stated reason. The borrower's live outstanding
balance becomes zero and future interest and penalties stop accruing. All
original financial information and history are preserved.

**Example.** Loan LN-0001 carries outstanding principal TZS 720,000, unpaid
accrued interest TZS 38,000 and accrued penalties TZS 12,000. On 15 June the
manager writes it off, recording the reason. The borrower's live balance becomes
0.00 and the loan stops accruing.

**Current system behaviour.** The write-off record captures the components
separately, at the instant of the decision and before the live balance is
zeroed — principal and penalties are each held as their own figure rather than a
single total, so that a treatment which distinguishes them can be applied
afterwards. The loan moves to status `written_off` and refuses further ordinary
repayments. No journal entry is written.

**Accounting decision required.** BOT distinguishes Sno 14 (written off **not
provided for**) from Sno 15 (provision). Please specify treatment **per
scenario** rather than a single journal, and note that the system holds no posted
provision balance today. The three components may attract different treatment,
so each is asked about separately.

| Question | Answer |
| --- | --- |
| Debit account — portion **not** previously provided for | `__________` |
| Credit account — portion **not** previously provided for | `__________` |
| Debit account — portion previously provided for | `__________` |
| Credit account — portion previously provided for | `__________` |
| **Principal** (720,000) — treatment | `__________` |
| **Unpaid accrued interest** (38,000) — if unpaid accrued interest exists at write-off, is it part of the write-off amount? If yes, specify its debit/credit treatment and whether previously recognised interest income must be reversed or otherwise adjusted. | `__________` |
| **Penalties** (12,000) — same treatment as principal, or reversed against the income they were accrued into? | `__________` |
| Recognition timing — at the manager's decision, at period end, or on another trigger? | `__________` |
| Treatment of any previously recognised provision — is it released, and against which account? | `__________` |
| Additional treatment/entry — should the system begin creating and posting a provision balance, so that there is something to release? | `__________` |
| Accountant notes | `__________` |

_The implemented write-off behaviour is not changed by asking this. Whatever the
answer, the operational record already keeps the components apart so the approved
treatment can be applied to write-offs that have already happened._

---

## RECOVERY-02 — Money recovered after write-off

**Business event.** A borrower pays something after their loan has been written
off. This is **not** a repayment: the debt is already off the books, the loan is
not reinstated, its status stays `written_off`, and the borrower's live balance
stays zero. Partial and repeated recoveries are both ordinary.

**Example.** Following the write-off above, the borrower pays TZS 150,000 in cash
on 1 August. Loan LN-0001 remains `written_off` and the borrower's live balance
remains 0.00.

**Current system behaviour.** Recoveries are held in their own table with amount,
date, method, reference, note, loan and recording user. They are deliberately
never written as payments, so they cannot be counted as repayment or interest
income. No journal entry is written, and MSP2-02 Sno 21 is not yet fed from these
records.

**Accounting decision required.** BOT identifies recovery of previously
written-off assets as income (Sno 21). The ledger posting is not established.

| Question | Answer |
| --- | --- |
| Debit account | `__________` |
| Credit account | `__________` |
| Recognition timing — on receipt of cash, or at another point? | `__________` |
| Treatment of previously recognised balance — does a recovery reverse any part of the earlier write-off entry, or stand alone? | `__________` |
| Additional treatment/entry — should MSP2-02 Sno 21 be fed from these records, and on what basis? | `__________` |
| If recoveries against one loan ever exceed the amount originally written off, what treatment applies to the excess? | `__________` |
| Accountant notes | `__________` |

---

## RESTRUCT-04 — Capitalisation on restructuring

**Business event.** A loan is restructured into a successor loan. The old loan is
preserved for audit, keeps its schedule and payments, and stops accepting
repayments. The successor's principal is **remaining principal + unpaid accrued
interest + unpaid penalties**. **No cash is disbursed as part of the
restructuring.** Interest subsequently accrues on the approved successor
principal, including the capitalised amounts.

**Example.** Remaining principal TZS 600,000 + unpaid accrued interest TZS 50,000
+ unpaid penalties TZS 20,000 = successor principal **TZS 670,000**. No money
moves. Interest then accrues on TZS 670,000.

**Current system behaviour.** The restructuring record keeps the three components
separately — principal carried, interest capitalised and penalties capitalised —
because a total cannot be decomposed after the fact. The link between the old
loan and its successor is recorded in both directions. No journal entry is
written.

> Restructuring is built and tested but is currently withheld from staff for a
> separate and unrelated Bank of Tanzania question (RESTRUCT-06, on whether a
> restructured facility counts as a disbursement for MSP2-09). The answer below
> is still needed and does not depend on that one.

**Accounting decision required.** Please answer the first question before the
rest — the remaining questions only arise if a journal entry is required.

| Question | Answer |
| --- | --- |
| **Does replacing the old loan receivable with the successor require a journal reclassification/transfer, or should the remaining principal receivable simply continue operationally under the successor loan without a separate journal entry?** | `__________` |
| If a journal entry is required — debit account for the principal carried (600,000) | `__________` |
| If a journal entry is required — credit account for the principal carried (600,000) | `__________` |
| Debit account — capitalised interest (50,000) | `__________` |
| Credit account — capitalised interest (50,000) | `__________` |
| Debit account — capitalised penalties (20,000) | `__________` |
| Credit account — capitalised penalties (20,000) | `__________` |
| Recognition timing — at approval of the restructuring, or at the successor's effective date? | `__________` |
| Treatment of previously recognised balance — were the interest and penalties already recognised as income when accrued, and does capitalisation change that recognition? | `__________` |
| Additional treatment/entry | `__________` |
| Accountant notes | `__________` |

---

## Information we need back

Before any of this can be implemented, we need the following returned.

**1. FEE-04.** The account pair at collection; whether a further pair applies at
retention; the account pair at refund; the point or points at which an entry
arises; and whether MSP2-02 Sno 18 should be fed from these records.

**2. WRITEOFF-02.** Account pairs for **both** the provided-for and
not-provided-for portions; separate treatment for principal, unpaid accrued
interest and penalties, including whether unpaid accrued interest forms part of
the write-off amount and whether previously recognised interest income must be
reversed or adjusted; the recognition trigger; and whether the system should
begin posting a provision balance at all, since none exists today.

**3. RECOVERY-02.** The account pair; whether a recovery stands alone or reverses
part of the write-off; whether Sno 21 should be fed from these records; and the
treatment where recoveries exceed the amount originally written off.

**4. RESTRUCT-04.** First, whether replacing the old receivable with the
successor is an accounting event at all. Then, if it is, the account pairs for
the principal carried; in either case the account pairs for capitalised interest
and capitalised penalties; the recognition point; and whether those amounts were
already recognised as income when accrued.

**5. The cross-cutting decision, which shapes all four.** _Should these events
post journal entries automatically, or should they continue to be recorded
operationally with an accountant making the entries manually?_ This must be
answered explicitly. Today MSP2-02 is compiled from manually entered finance
entries. If automatic posting is wanted, we need the account mapping above. If
manual entry is acceptable, the operational records already carry everything
needed and no code change is required.

**6. A chart of accounts** — or at minimum the account names and codes for every
account named in the answers. No account code will be invented on your behalf.

Until these are answered, all four events continue to be recorded and traced
operationally with no journal entry, and no screen states or implies that
anything has been posted.
