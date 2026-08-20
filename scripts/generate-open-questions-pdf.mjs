#!/usr/bin/env node
/**
 * Render the open business and regulatory questions as a PDF.
 *
 * These questions are not a development backlog. Each one blocks a module that
 * moves real money, and the answers have to come from the institution or from
 * the Bank of Tanzania — so the list needs to leave the repository and reach
 * people who do not read Markdown in a terminal: a board, a compliance officer,
 * a supervision contact.
 *
 * `docs/04-DECISION-REGISTER.md` is the authority, and each question below
 * carries its register identifiers so the two can be read against each other.
 * When a question is answered it is settled there first, and this is
 * regenerated.
 *
 * pdfkit, because the API already depends on it to render filed returns
 * (`apps/api/src/modules/exports/pdf.ts`). No new dependency for a document
 * that is produced a handful of times a year.
 *
 *   node scripts/generate-open-questions-pdf.mjs [output.pdf]
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import PDFDocument from 'pdfkit';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUTPUT = resolve(ROOT, process.argv[2] ?? 'docs/OPEN-QUESTIONS.pdf');

/** A4 portrait, in points. Portrait because this is prose, not a wide return. */
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
const BOTTOM = PAGE.height - MARGIN - 24;

const FONT = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const FONT_ITALIC = 'Helvetica-Oblique';

const INK = '#16202c';
const MUTED = '#5b6a7d';
const RULE = '#dfe5ec';
const ACCENT = '#1a4f8a';

/**
 * Every question, with the four things somebody needs in order to answer it.
 *
 * `blocks` says what cannot be built. `current` says what the system does in the
 * meantime — and in every case it is the conservative option, because the rule
 * this project works under is that an unanswered question is never resolved by
 * guessing. `needs` says what an answer has to contain to be usable.
 *
 * `who` is who can answer. Splitting the institution's questions from BOT's
 * matters: they go to different people, on different timescales, and mixing
 * them is how a list like this stalls.
 */
const SECTIONS = [
  {
    title: 'Questions for the institution',
    blurb:
      'Policy decisions belonging to the microfinance service provider. None can be ' +
      'inferred from the supplied documentation, and each governs money owed by or to ' +
      'a borrower.',
    questions: [
      {
        ref: 'SHARES-01…06 · §13.5',
        title: 'Shares',
        question:
          'What is the par value of a share? What rules govern subscription? Are shares ' +
          'transferable between members? What is the dividend declaration process? Are ' +
          'shares withdrawable?',
        why:
          'Shares are members’ capital. Treating a withdrawable share as permanent capital ' +
          'overstates capital adequacy; declaring a dividend under the wrong rule distributes ' +
          'money that was not earned.',
        blocks:
          'The shares module entirely. The permissions share.read and share.manage exist and ' +
          'enforce nothing.',
        current:
          'Nothing is built — no table, no screen, no arithmetic. The MSP2 shares line reports ' +
          'nil, which is correct: the institution holds no shares in this system. There is no ' +
          'partial implementation to mislead anyone.',
        needs: 'All five answers, plus the Bank of Tanzania’s expected treatment on MSP2-01.',
      },
      {
        ref: 'GROUP-01…04 · §13.6',
        title: 'Group lending',
        question:
          'Is liability fully joint, or several? Does a group loan disburse to the group or ' +
          'to members individually? What are the group guarantee rules? How is a default ' +
          'handled?',
        why:
          'Liability decides who owes what after a default, which decides classification and ' +
          'provisioning, which decides the whole of MSP2-03 for those loans.',
        blocks: 'Groups entirely — membership, joint-liability arithmetic, group disbursement.',
        current:
          'No group tables and no group code. A loan to a member of a group is an ordinary loan ' +
          'to that borrower, which is accurate under several liability and would need revisiting ' +
          'under joint liability. BOT’s loan-type taxonomy already carries group headings, so ' +
          'such a loan can be reported; what does not exist is any group entity.',
        needs: 'The liability model first. The other three answers follow from it.',
      },
      {
        ref: 'FEE-01…03 · §13.8',
        title: 'Loan fees',
        question:
          'What qualifies as a fee? When is it charged? Is it refundable? How does it interact ' +
          'with settlement and repayment?',
        why:
          'A fee is money the borrower owes that is neither interest nor principal, so it ' +
          'changes both the outstanding balance and the income statement.',
        blocks: 'Fee accrual. Nothing charges a fee.',
        current:
          'The payment allocator has a fee bucket in a fixed position — second, after penalties ' +
          'and before interest — and it allocates nil. The position is deliberate and must not ' +
          'move: introducing the bucket later at a different point in the order would ' +
          'retrospectively change how every payment already recorded would have been split.',
        needs: 'A definition of a fee and a charging trigger. The bucket is already in place.',
      },
      {
        ref: 'SETTLE-01…04 · §13.8',
        title: 'Early settlement',
        question:
          'Does a settlement discount apply? What happens to future interest, to accrued ' +
          'penalties, and to fees? Which date governs the settlement figure?',
        why:
          'Future-interest treatment alone can change a settlement figure by the entire ' +
          'remaining interest of the loan.',
        blocks: 'Any “settle this loan today” operation.',
        current:
          'No settlement endpoint exists. A borrower paying off early records ordinary ' +
          'repayments, which reduce the balance exactly as they otherwise would. Nothing is ' +
          'waived and nothing is discounted, because no rule says anything should be.',
        needs:
          'All five answers. A partial answer produces a partial settlement figure, which is ' +
          'worse than none.',
      },
      {
        ref: 'RESTRUCT-01…05 · §13.8',
        title: 'Restructuring',
        question:
          'What makes a loan eligible? Who approves it? What happens to accrued interest, to ' +
          'penalties, to fees, and to outstanding principal? What becomes of the old schedule, ' +
          'and how is the new one generated? What is the accounting treatment? What is the ' +
          'reporting treatment?',
        why: 'A restructure rewrites a live loan’s schedule. Done without a rule, it rewrites history.',
        blocks: 'Any restructure operation.',
        current:
          'Nothing exists — no partial workflow that could half-apply and leave a loan ' +
          'inconsistent. The loan status machine has no restructured state and no transition ' +
          'to one.',
        needs:
          'All nine answers, plus the Bank of Tanzania’s view on whether a restructured loan ' +
          'resets its classification.',
      },
      {
        ref: 'RECOVERY-01 · WRITEOFF-01',
        title: 'Write-offs and recoveries',
        question:
          'Is a recovery on a written-off loan a repayment, separate income, or a reinstatement ' +
          'of the loan? And separately: who may write a loan off, at what point, and what ' +
          'happens to accrued interest, penalties and any provision already raised?',
        why:
          'It decides which line of MSP2-02 the money appears on, and whether the loan returns ' +
          'to the book.',
        blocks:
          'Recording a recovery — and writing a loan off at all. There is no write-off ' +
          'operation in the application; the status is reachable only by a direct database ' +
          'change. The two are one decision.',
        current:
          'A payment against a written-off loan is refused, with a message naming the status. ' +
          'Written-off is terminal in the status machine — there is no transition out of it. A ' +
          'recovery therefore cannot be quietly recorded as an ordinary repayment, which would ' +
          'put money on a return under a heading nobody chose.',
        needs:
          'The accounting treatment, then a dedicated operation. Not a relaxation of the ' +
          'current refusal. Note that BOT’s own MSP2-02 taxonomy already carries both a ' +
          'bad-debts-written-off line (Sno 14) and an income-from-recovery line (Sno 21), ' +
          'which suggests income rather than repayment — but says nothing about whether the ' +
          'loan is reinstated or the borrower’s balance moves.',
      },
      {
        ref: 'IDENTITY-01',
        title: 'Cross-institution staff identity',
        question: 'May one person hold staff accounts at two different institutions?',
        why:
          'Email identifies a user at login, before any institution is known, so the address ' +
          'must be unique across the whole system. An address therefore belongs to exactly one ' +
          'institution, for all time.',
        blocks: 'Nothing today. It is a limit somebody will eventually meet.',
        current:
          'Inviting an address that already has an account anywhere is refused. Within the ' +
          'institution the refusal is specific and useful. Across institutions it is a generic ' +
          'conflict that names no table, no institution and no person.',
        needs:
          'If the answer is yes: a membership table separating identity from institution. That ' +
          'is a schema and login change, not a small one.',
      },
    ],
  },
  {
    title: 'Questions for the Bank of Tanzania',
    blurb:
      'Interpretation questions about the MSP2 return. Each is held as an explicit parameter ' +
      'and the convention actually used is printed on the compiled form, so whichever answer ' +
      'arrives, what was filed remains auditable.',
    questions: [
      {
        ref: 'BOT-11.2',
        title: 'Rate annualisation',
        question:
          'Are MSP2-04 rates read as simple (monthly × 12) or effective ((1 + monthly)¹² − 1)?',
        why:
          'At 5% a month the two differ by nearly twenty percentage points — 60% against ' +
          '79.59%. The wrong convention misstates every rate on the form.',
        blocks: 'Nothing. Both conventions are implemented.',
        current:
          'An explicit query parameter, simple by default, and the convention used is printed ' +
          'on the compiled return. The choice is visible on the filed form rather than buried ' +
          'in the compiler.',
        needs:
          'One answer. The parameter stays either way — it is what makes the answer auditable.',
      },
      {
        ref: 'BOT-11.4',
        title: 'Age-band reference date',
        question: 'As at which date is a borrower’s age measured for MSP2-10’s demographic bands?',
        why:
          'A borrower who turns 36 during a quarter falls in a different band depending on the ' +
          'date chosen.',
        blocks: 'Nothing. The date is a required argument.',
        current:
          'Nothing defaults it, so no caller can accidentally measure age as at today when the ' +
          'return covers a quarter that ended months ago.',
        needs: 'The reference date. The parameter already exists to receive it.',
      },
      {
        ref: 'BOT-11.5',
        title: 'Housing loans under 91 days overdue',
        question:
          'BOT’s housing microfinance provisioning schedule begins at 91 days and defines no ' +
          'band below it. How should a housing loan 0–90 days overdue be classified?',
        why:
          'Every other loan type has a band covering its first ninety days. Housing does not, ' +
          'so there is no rule to apply.',
        blocks: 'Classification of housing loans in their first ninety days of arrears.',
        current:
          'Such a loan is NOT classified, and is never folded into Current. It is surfaced on ' +
          'its own row so the gap reaches an operator. Quietly calling it performing would ' +
          'understate provisions and file a wrong MSP2-03.',
        needs: 'A ruling. Until then the gap stays visible, which is the point.',
      },
      {
        ref: 'BOT-11.8 · BOT-11.8B',
        title: 'Fiscal year for the year-to-date column',
        question:
          'Does MSP2-02’s year-to-date column mean the calendar year or the institution’s own ' +
          'fiscal year? And must a fiscal year begin on a quarter boundary?',
        why:
          'The second half of this question is not academic. A fiscal year starting on a ' +
          'quarter boundary keeps every year-to-date window at twelve months or fewer. A start ' +
          'month that does not — December, say — makes one quarter straddle the boundary and ' +
          'produces a THIRTEEN-month window: Q4 2026 would run from 1 December 2025 to 31 ' +
          'December 2026.',
        blocks: 'Nothing. Both are expressible.',
        current:
          'Entries are dated rather than bucketed by quarter, so the same rows aggregate both ' +
          'ways. The fiscal year start is a required parameter, never defaulted, and the window ' +
          'actually used is reported on the form as “year to date from”. The thirteen-month ' +
          'case is left exactly as it is and pinned by test, because choosing a rule for ' +
          'non-aligned fiscal years would be inventing an answer.',
        needs:
          'One answer on the year, plus a note on whether a fiscal year must begin on a quarter ' +
          'boundary.',
      },
      {
        ref: 'AUDIT-01',
        title: 'Audit retention period',
        question: 'How long must an institution retain its audit trail?',
        why:
          'Implementing deletion is a one-way door. Records removed on a schedule this system ' +
          'invented cannot be recovered for an inspection that asks for them.',
        blocks: 'Nothing. Retention is simply not implemented.',
        current:
          'Nothing is ever deleted. There is no purge job, no archival and no retention setting. ' +
          'The audit table has no update or delete policy for any role, so entries cannot be ' +
          'amended or removed even by the application.',
        needs:
          'The retention period. Note that keeping everything is the safe default and is the ' +
          'current behaviour.',
      },
    ],
  },
];

const FOOTNOTE =
  'Prepared from docs/03-STATUS.md, which remains the authoritative list. Nothing in this ' +
  'document is a proposed answer. Where the system must do something while a question is ' +
  'open it refuses, or records the fact and leaves it visible — because on a system that ' +
  'moves real money, a guess does not announce itself.';

function main() {
  const document = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: {
      Title: 'MFI Manager — open business and regulatory questions',
      Author: 'MFI Manager',
      Subject: 'Decisions required before the blocked modules can be built',
    },
    autoFirstPage: false,
  });

  const stream = createWriteStream(OUTPUT);
  document.pipe(stream);

  let pageNumber = 0;

  const newPage = () => {
    document.addPage({
      size: [PAGE.width, PAGE.height],
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    });
    pageNumber += 1;
    document
      .font(FONT)
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(`MFI Manager — open questions · page ${pageNumber}`, MARGIN, PAGE.height - MARGIN, {
        width: CONTENT_WIDTH,
        align: 'right',
        lineBreak: false,
      });
    document.y = MARGIN;
  };

  /** Start a new page when `needed` points will not fit. */
  const reserve = (needed) => {
    if (document.y + needed > BOTTOM) {
      newPage();
    }
  };

  const heightOf = (text, options) => document.heightOfString(text, options);

  newPage();

  // ── Cover ───────────────────────────────────────────────────────────────
  document.moveDown(2);
  document
    .font(FONT_BOLD)
    .fontSize(22)
    .fillColor(INK)
    .text('Open business and regulatory questions', { width: CONTENT_WIDTH });
  document.moveDown(0.4);
  document
    .font(FONT)
    .fontSize(12)
    .fillColor(ACCENT)
    .text('MFI Manager — decisions required before the blocked modules can be built', {
      width: CONTENT_WIDTH,
    });

  document.moveDown(1.2);
  document
    .moveTo(MARGIN, document.y)
    .lineTo(MARGIN + CONTENT_WIDTH, document.y)
    .lineWidth(0.75)
    .strokeColor(RULE)
    .stroke();
  document.moveDown(1);

  document
    .font(FONT)
    .fontSize(9.5)
    .fillColor(INK)
    .text(
      'Twelve questions, carrying thirty-one entries in the decision register. Each blocks ' +
        'a module that moves real money, and none can be answered from the supplied ' +
        'documentation. Until an answer arrives the system refuses rather than guesses — ' +
        'every “current behaviour” below is the conservative option, chosen so that no ' +
        'borrower’s balance moves for a reason nobody decided.',
      { width: CONTENT_WIDTH, align: 'left' },
    );

  document.moveDown(0.8);
  document
    .font(FONT_ITALIC)
    .fontSize(9)
    .fillColor(MUTED)
    .text(
      'Answering a question does not by itself change anything. Each answer becomes a change ' +
        'that is reviewed and tested like any other.',
      { width: CONTENT_WIDTH },
    );

  document.moveDown(1.5);

  // ── Sections ────────────────────────────────────────────────────────────
  for (const section of SECTIONS) {
    reserve(90);

    document.moveDown(0.5);
    document
      .font(FONT_BOLD)
      .fontSize(14)
      .fillColor(INK)
      .text(section.title, MARGIN, document.y, { width: CONTENT_WIDTH });
    document.moveDown(0.25);
    document
      .font(FONT)
      .fontSize(9)
      .fillColor(MUTED)
      .text(section.blurb, MARGIN, document.y, { width: CONTENT_WIDTH });
    document.moveDown(0.8);

    for (const item of section.questions) {
      const bodyOptions = { width: CONTENT_WIDTH - 12 };

      // Measure the whole block so a question is never split across pages
      // mid-field, which is how a reader comes to answer half of one.
      const needed =
        18 +
        heightOf(item.question, bodyOptions) +
        heightOf(item.why, bodyOptions) +
        heightOf(item.blocks, bodyOptions) +
        heightOf(item.current, bodyOptions) +
        heightOf(item.needs, bodyOptions) +
        78;

      reserve(Math.min(needed, BOTTOM - MARGIN));

      const top = document.y;

      document
        .font(FONT_BOLD)
        .fontSize(11)
        .fillColor(ACCENT)
        .text(`${item.title}`, MARGIN + 12, document.y, { width: CONTENT_WIDTH - 12 });

      document
        .font(FONT)
        .fontSize(8)
        .fillColor(MUTED)
        .text(item.ref, MARGIN + 12, top + 1, { width: CONTENT_WIDTH - 12, align: 'right' });

      document.moveDown(0.35);
      document.x = MARGIN + 12;

      const field = (label, text, emphasis = false) => {
        document
          .font(FONT_BOLD)
          .fontSize(7.5)
          .fillColor(MUTED)
          .text(label.toUpperCase(), MARGIN + 12, document.y, { width: CONTENT_WIDTH - 12 });
        document
          .font(emphasis ? FONT_BOLD : FONT)
          .fontSize(9)
          .fillColor(INK)
          .text(text, MARGIN + 12, document.y, bodyOptions);
        document.moveDown(0.45);
      };

      field('Question', item.question, true);
      field('Why it matters', item.why);
      field('What it blocks', item.blocks);
      field('Current behaviour', item.current);
      field('Required to unblock', item.needs);

      // A rule under each question, so the eye can find where one ends.
      document
        .moveTo(MARGIN, document.y)
        .lineTo(MARGIN + CONTENT_WIDTH, document.y)
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke();
      document.moveDown(0.7);
      document.x = MARGIN;
    }
  }

  // ── Closing note ────────────────────────────────────────────────────────
  reserve(80);
  document.moveDown(0.5);
  document
    .font(FONT_ITALIC)
    .fontSize(8.5)
    .fillColor(MUTED)
    .text(FOOTNOTE, MARGIN, document.y, { width: CONTENT_WIDTH });

  document.end();

  return new Promise((resolveDone, reject) => {
    stream.on('finish', resolveDone);
    stream.on('error', reject);
  });
}

await mkdir(dirname(OUTPUT), { recursive: true });
await main();
process.stdout.write(`Wrote ${OUTPUT}\n`);
