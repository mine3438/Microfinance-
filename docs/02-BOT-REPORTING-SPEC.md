# BOT MSP2 Reporting Specification

**Source:** `docs/reference/BOT-MSP2-template.xlsx` — the official BOT
template, supplied by the product owner. 11 sheets: MSP2-01 … MSP2-10
plus `Static Information`.
**Derived data:** `docs/reference/bot-taxonomies.json` — every list,
rate, and validation rule below in machine-readable form, extracted
directly from the template.
**Status:** This document is now the **authority** on BOT reporting.
Where it disagrees with the PRD, TRD, or Schema Reference, it wins —
those were written from interpretation; this was read from BOT's own
file.

---

## 0. Why This Changes the Plan

The analysis (`00-PROJECT-ANALYSIS.md` R10) flagged that every MSP2 form
had been built against the team's *reading* of the spec, and that BOT's
own validator was the only ground truth — never run. This template is
that ground truth arriving early, which is the best possible outcome.

It also invalidates several assumptions carried in the prior documents.
Five findings change the architecture:

| # | Finding | Consequence |
|---|---|---|
| 1 | **MSP2-01 is a full balance sheet and MSP2-02 a full P&L** — share capital, retained earnings, reserves, PPE with accumulated depreciation, deferred tax, 16 expense lines, tax provision | These are accounting statements. They cannot be compiled from a loan book. Deferring accounting entirely is no longer possible — see §9 |
| 2 | **A complete loan-loss provisioning matrix exists**, with rates and day bands BOT defines | New required calculation engine. Feeds MSP2-01 and MSP2-03. Absent from every prior document |
| 3 | **Housing microfinance loans use a different classification schedule** | A single classification function is wrong. Two schedules required |
| 4 | **MSP2-10 requires branch counts and employee counts per district** | Multi-branch is not optional. It is a reporting requirement |
| 5 | **Compulsory savings appears in three forms** and reduces provisions | Savings is not an optional add-on; compulsory savings is part of BOT's model |

A sixth finding is good news: **MSP2-08 is trivial** — see §7.

---

## 1. Common Structure

Every form carries a header block: institution name, MSP code, and the
quarter-end date, all sourced from MSP2-01 and mirrored via cross-sheet
formulas (`=[1]MSP2_01!C2`). All amounts are **TZS to 2 decimal places**
("Amount in TZS 0.00"), confirming `NUMERIC(15,2)` as the correct storage
type.

**Column `Sno` is the wire identifier.** Every form numbers its rows in
column A, and — critically — **the cross-form validation rules reference
Sno values, not spreadsheet cells.** `C67=MSP2_04C15` means "column C at
Sno 67 equals MSP2-04 column C at Sno 15." The compiler must therefore
address cells by (form, Sno, column), and the Sno map must be treated as
a stable published contract, not an artifact of row position.

---

## 2. MSP2-01 — Balance Sheet

61 line items. Assets: cash and cash equivalents (split into cash in
hand, bank balances **separated into non-agent and agent banking**, MSP
balances, MNO float), debt securities net of allowance, equity
investments net, loans net, PPE net of accumulated depreciation, other
assets. Liabilities: borrowings split Tanzania/abroad across five and
three sub-categories respectively, cash collateral / loan insurance /
compulsory savings, tax payable, dividend payable, other payables.
Capital: nine lines including paid-up ordinary and preference shares,
capital grants, donations, share premium, general reserves, retained
earnings, profit/loss, other reserves.

**Validation:** `Sno33 (Total Assets) = Sno61 (Total Liabilities and
Capital)`. The balance sheet must balance — enforced by BOT.

Of these 61 lines, the loan book supplies roughly **four** (loans to
clients, accrued interest, allowance for probable losses, and — with a
savings module — compulsory savings). Everything else is accounting data
that does not exist in an operational lending system.

## 3. MSP2-02 — Statement of Income and Expense

42 line items, **two columns: quarterly amount and year-to-date**. A
year-to-date column means the system must retain and re-derive prior
quarters within the fiscal year, not just the current one.

Interest income across five sources; interest expense across five;
non-interest income across six; **non-interest expenses across sixteen
named lines** (management salaries, employee salaries, wages, pension
contributions, skills and development levy, rent, depreciation,
amortisation, foreclosure and litigation, management fees, auditors'
fees, taxes, licence fees, insurance, utilities, other); bad debts
written off; provision for bad and doubtful debts; income tax provision.

**Validation:** `Sno42 YTD (Net income after tax) = MSP2-01 Sno59
(Profit/Loss)`.

The prior documents modelled this as a flat `expenses` table with
client-side category strings. The real form needs sixteen specific
expense classifications plus separate income taxonomies, each mapping to
an exact BOT line — and the YTD column. The existing free-text category
approach (R12) cannot produce this reliably.

## 4. MSP2-03 — Sectoral Classification and Provisioning

**22 sectors, exact and fixed:**

Agriculture · Fishing · Forest · Hunting · Financial Intermediaries ·
Mining and Quarrying · Manufacturing · Building and Construction ·
Real Estate · Leasing · Transport and Communication · Trade · Tourism ·
Hotels and Restaurants · Warehousing and Storage · Electricity · Gas ·
Water · Education · Health · Other Services · Personal (Private)

Per sector: number of borrowers, total outstanding, and the outstanding
split across five classification buckets — **Current, ESM, Substandard,
Doubtful, Loss** — plus amount written off during the quarter.

### 4.1 Classification bands and provisioning rates

**This is the single most valuable thing in the template, and it appears
in none of the prior documentation.**

| Days past due | Class | Provision rate |
|---|---|---|
| 0–5 | Current | **1%** |
| 6–30 | ESM | **5%** |
| 31–60 | Substandard | **25%** |
| 61–90 | Doubtful | **50%** |
| > 90 | Loss | **100%** |

**Housing microfinance loans use a separate, longer schedule:**

| Days past due | Provision rate |
|---|---|
| 91–180 | **25%** |
| 181–360 | **50%** |
| > 360 | **100%** |

Two consequences. First, the bands are far tighter than the prior
documents implied — a loan is no longer "Current" after **five days**,
and reaches Loss at 91 days. Second, classification is **loan-type
dependent**: a housing microfinance loan at 100 days past due is
Substandard (25%), while any other loan at 100 days is Loss (100%). A
single classification function produces a materially wrong provision.

### 4.2 Derived figures

- `Provision Amount` per class = class outstanding × provision rate
- `Net Provision` = provision − cash collateral / insurance guarantee /
  compulsory savings
- `Total (Net Amount)` = outstanding − net provision
- **NPL ratio** = (Substandard + Doubtful + Loss) ÷ Total Outstanding ×
  100

**Validation:** per sector, `Total Outstanding = Current + ESM +
Substandard + Doubtful + Loss`. And `Sno67 (total borrowers) = MSP2-04
Sno15 (total borrowers)`.

The net provision feeds MSP2-01's "Allowance for Probable Losses," and
the compulsory-savings deduction is why savings cannot be treated as an
unrelated module.

## 5. MSP2-04 — Interest Rate Structure

**12 loan types**, with Salaried Loans splitting into two reported
sub-rows:

Business Group · Business Solidarity/Small Group · Business Individual ·
Agriculture · **Housing Microfinance** · Microleasing/Hire purchase ·
Loans to Other MSPs (e.g. SACCOS) · Micro Insurance · Education ·
Salaried *(a. Government Employees, b. Non-Government Employees)* ·
Emergence · Other Micro

Per type: number of borrowers, outstanding amount, and — separately for
**straight-line** and **reducing-balance** amortisation — the lowest and
highest nominal rate plus a weighted average. **All rates are % per
annum.**

Three implications:

1. The system stores a **monthly decimal** rate (`0.05`); BOT wants
   **annual percent**. Conversion is required, and the direction of that
   conversion (×12 simple, or compounded) is a business rule — §11.2.
2. Lowest and highest per type must be tracked, so the compiler needs
   min/max over the loan set, not just an average.
3. Rates are reported *by amortisation method*, so `interest_method`
   must be a first-class reporting dimension.

**Validation:** `Sno15 col C = MSP2-03 Sno67 col C` (borrower counts
agree) and `Sno15 col D = MSP2-01 Sno17 + Sno22` (total outstanding
equals net loans plus allowance, i.e. gross).

### 5.1 An anomaly in BOT's own formula — flagged, not silently corrected

The weighted-average cells compute:

```
E = (outstanding ÷ total_outstanding) × lowest
  + (outstanding ÷ total_outstanding) × highest
```

That is `weight × (lowest + highest)` — **twice** the weighted midpoint.
A conventional weighted average would divide by two.

I am not going to "fix" this. BOT's EDI validator is the authority, and
deviating from the template's own arithmetic is the more likely way to
fail submission. **Recommendation: replicate the template formula
exactly, and raise the discrepancy with BOT or the institution's
compliance contact.** Recorded here so the choice is visible rather than
buried in code. See §11.3.

## 6. MSP2-05 — Liquid Assets

Eight liquid asset categories summing to total available liquid assets,
against total assets drawn from MSP2-01.

- `Required Minimum Liquid Assets = 5% × Total Assets`
- `Excess (Deficiency) = Available − Required`
- `Liquid Asset Ratio = Available ÷ Total Assets`

**This is a prudential requirement, not merely a disclosure.** The system
should compute the ratio continuously and warn when it approaches or
breaches 5% — a breach is a supervisory matter, and discovering it at
quarter-end filing is too late to act on.

**Validation:** the first four lines tie to MSP2-01 Sno2, Sno3, Sno6,
Sno7 respectively.

## 7. MSP2-07 and MSP2-08 — Bank, MSP, MNO Balances

### MSP2-07 — Deposits and Borrowings

Four sections, each row carrying **TZS**, **foreign-currency equivalent
in TZS**, and totals, for **both deposits and borrowings**:

1. **Banks in Tanzania** — up to 28 rows, chosen from a fixed list of
   **56 banking institutions** (`Static Information` list A, exposed as
   the `Banks` named range)
2. **Microfinance Service Providers** — up to 14 rows
3. **Balances with MNOs** — six fixed: MPESA, AIRTEL MONEY, T-PESA,
   HALOPESA, TIGOPESA, ZPESA
4. **Banks Abroad** — up to 6 rows

Six cross-validations tie its totals into MSP2-01 (§14 of the JSON).

The foreign-currency column means **multi-currency holdings must be
recorded with a TZS equivalent**, which implies a rate and a rate date.
No prior document mentions foreign currency at all.

### MSP2-08 — Agent Banking

**This answers the open question in Architecture §13.7.** The
Implementation Plan assumed MSP2-08 needed "an agent transaction table"
and advised against building it speculatively. It does not. The form is
a **single balance column per bank**, drawn from a second fixed list of
**52 institutions** (the `Agent_Banking` named range), with one
validation: `total = MSP2-01 Sno5 (Agent-Banking Balances)`.

It is the same shape as one column of MSP2-07 and costs almost nothing
once `bank_accounts` exists. **Recommendation: build it.** The PRD's
"all 10 forms" claim becomes true at negligible marginal cost, and the
speculative-schema concern that motivated deferring it does not apply.

## 8. MSP2-06, MSP2-09, MSP2-10 — Operational Forms

### MSP2-06 — Complaints

Substantially richer than the prior documents' "resolved/unresolved
counts." It is a **quarterly roll-forward**, reported as **both a count
and a TZS value**, across **six nature categories** (Interest Rate,
Agreements, Repayments, Loan Statement, Loan Processing, Others):

```
opening + new − resolved by institution − resolved by other parties
                                        = unresolved at quarter end
```

Plus four referral lines: complaints referred to Bank of Tanzania, Fair
Competition Commission, Courts, and Other Parties.

**Validation:** every row's total column must equal the sum of its six
nature columns, and the closing balance must satisfy the roll-forward.

This requires complaints to carry a **monetary value**, a **resolution
route** (institution vs. external party), and a **referral destination** —
none of which exist in the prior schema.

### MSP2-09 — Loans Disbursed by Gender and Sector

The same 22 sectors, each split by **Loans Disbursed to Female** and
**to Male** (number and amount), for loans disbursed **during the
quarter**. This form matches the prior documentation and is the least
affected.

### MSP2-10 — Geographic Distribution

The largest form: **31 regions and 193 districts**, split Mainland
Tanzania and Zanzibar, in a fixed hierarchy with region subtotals,
`Total Zanzibar`, and `Grand Total`. Council-type suffixes are
significant (`CC` City Council, `MC` Municipal, `DC` District Council,
`TC` Town Council). Regions are ordered alphabetically by BOT's
instruction.

Per district: **number of branches**, **number of employees**,
**compulsory savings**, then borrowers, loan counts, and outstanding
amounts each split by **age band (Up to 35 Years / Above 35 Years) ×
gender (Female / Male)** — twelve measure columns.

Three hard requirements fall out of this:

1. **Multi-branch is mandatory.** You cannot report branches and
   employees per district without modelling branches and staff
   assignment. This was "explicitly out of scope" in PRD §4.2.
2. **Age banding requires date of birth at reporting time.** The
   `clients` table has `date_of_birth`, so the data exists — but the
   *reference date* for the band is a business rule (§11.4).
3. **District becomes a controlled vocabulary**, not free text. The
   prior schema's free-text `district`/`region` cannot aggregate into
   this form reliably.

**Validation:** `Grand Total compulsory savings = MSP2-01 Sno46`.

---

## 9. The Accounting Decision, Revisited

You chose to defer accounting depth until after the first BOT filing.
That decision was made before this template was available, and the
template contradicts its premise: **MSP2-01 and MSP2-02 are the balance
sheet and P&L.** There is no version of "all 10 forms" that does not
produce financial statements.

Roughly **95 of MSP2-01 and MSP2-02's 103 line items cannot be derived
from lending operations.** They are accounting balances.

Three ways forward:

**Option 1 — Quarterly financial-statement entry (recommended for v1).**
Model MSP2-01 and MSP2-02 as a structured quarterly dataset the
institution fills in, with every loan-derived line **auto-populated and
locked** (loans to clients, accrued interest, allowance for probable
losses from the §4 provisioning engine, compulsory savings, and the
MSP2-07/08 balances). BOT's own cross-validations run as pre-submission
checks, so an unbalanced balance sheet is caught before filing.

This matches how these institutions work today — they already produce
these figures in spreadsheets — while removing the error-prone parts and
the reconciliation. It delivers all 10 forms without building a general
ledger.

**Option 2 — Full double-entry ledger.** Every line derives from posted
journals; nothing is hand-entered. Correct, and the eventual destination,
but it is the largest item in the project and it delays the first filing
— which is the only assumption that still hasn't been tested against
reality.

**Option 3 — Ship 8 forms.** Cut MSP2-01 and MSP2-02, contradict the
PRD's core claim. Not recommended; §2's validations mean several other
forms lose their cross-checks too.

**Recommendation: Option 1 for v1, with the ledger seam retained.** The
entered figures become the ledger's opening balances when it lands, so
nothing is wasted. This is the path that gets a real report to BOT
soonest, which is what actually de-risks the product.

---

## 10. Architecture Impact

Changes to `01-ARCHITECTURE.md` implied by this specification:

1. **New `provisioning` domain service** — classification bands and
   provision rates as versioned reference data (BOT can revise them),
   dual schedules for standard vs. housing microfinance, net-of-collateral
   computation, NPL ratio. Classification becomes loan-type dependent.
2. **`branches` promoted from "requested feature" to reporting
   requirement**, with employee assignment per branch and branch→district
   mapping.
3. **Geography as seeded reference tables** — 31 regions, 193 districts,
   with council-type suffixes, replacing free-text columns. Client and
   branch addresses become FKs.
4. **`financial_statement_lines`** — quarterly, Sno-keyed, per form, with
   locked auto-derived lines and editable entered lines (Option 1).
5. **`bank_accounts` extended** — institution type (bank / MSP / MNO /
   foreign bank), fixed institution lists as seed data, TZS and
   foreign-currency-equivalent columns, quarter-end snapshots, and a
   separate agent-banking balance for MSP2-08.
6. **Complaints extended** — monetary value, nature category (6),
   resolution route, referral destination, and quarter roll-forward
   derivation.
7. **Compulsory savings** as a savings product attribute, surfaced to
   MSP2-01, MSP2-03 (as a provision deduction), and MSP2-10.
8. **Rate reporting** — annual-percent conversion, min/max per loan type,
   split by amortisation method.
9. **Cross-form validation engine** — all 18 rules in
   `bot-taxonomies.json` run as pre-submission checks, blocking export on
   failure. This plus the freshness gate (Architecture §10.3) means the
   system refuses to file a report it knows is wrong.
10. **Sno-addressed cell mapping** — the exporter writes by (form, Sno,
    column), never by hardcoded row index, so a template revision is a
    data change.

**Sequencing note:** the template also means the compliance module can be
built and tested against BOT's actual arithmetic *before* a real filing.
Every formula in every form is now reproducible as a test fixture. That
retires most of R10 — not by guessing better, but by having the answer
key.

---

## 11. New Questions Raised by the Template

Only the template could have surfaced these; none are answerable from
the prior documents.

**11.1 Provisioning rate authority.** Are the rates in §4.1 current, or
does BOT revise them? They must be versioned reference data with
effective dates either way, but I need to know whether historical
restatement is required when they change.

**11.2 Rate conversion.** The system stores monthly decimal rates; BOT
wants annual percent. Simple (`monthly × 12 × 100`) or effective
(`((1+m)^12 − 1) × 100`)? These differ materially at microfinance rates —
5% monthly is 60% simple or 79.6% effective.

**11.3 The MSP2-04 weighted-average anomaly** (§5.1). Confirm: replicate
BOT's formula exactly, or compute a conventional weighted average? My
recommendation is replicate-and-flag.

**11.4 Age band reference date** (MSP2-10). Is "Up to 35 Years"
determined at loan disbursement or as at the quarter-end reporting date?

**11.5 Housing microfinance identification.** The dual classification
schedule keys off loan type. Is `Housing Microfinance Loans` in MSP2-04
exactly the set that gets the §4.1 housing schedule?

**11.6 Foreign currency** (MSP2-07). Which rate and rate date convert
holdings to the TZS equivalent — BOT's published rate, the institution's
bank rate, quarter-end spot?

**11.7 Compulsory savings.** Is this a savings product attribute, a
per-loan collateral amount, or both? It appears in three forms and
deducts from provisions, so its source of truth needs to be unambiguous.

**11.8 Fiscal year** (MSP2-02 YTD). Does the year-to-date column follow
the calendar year, or an institution-configurable fiscal year?

**11.9 Template versioning.** MSP2-05 carries "Template is version
0.0.0.0". Does BOT publish versioned templates, and must submissions
declare which version they target?

---

## 12. Machine-Readable Reference

`docs/reference/bot-taxonomies.json` contains, extracted directly from
the template rather than transcribed:

`sectors` (22) · `loan_types` (14 rows) · `provisioning_standard` (5
bands) · `provisioning_housing` (3 bands) · `classification_columns` (5)
· `complaint_natures` (6) · `complaint_rows` (9) · `banks_list_A` (56) ·
`banks_list_B_agent` (52) · `mnos` (6) · `geography` (31 regions, 193
districts, Mainland/Zanzibar) · `msp2_01_lines` (61 Sno-keyed line items
with formulas) · `msp2_02_lines` (42) · `validations` (18 cross-form
rules) · `msp2_10_dimensions`.

This becomes seed data. It should never be retyped by hand — the
extraction script reads the template, so a BOT template revision is
re-run, not re-transcribed.
