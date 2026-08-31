#!/usr/bin/env node
/**
 * Render the outstanding accounting-policy questions as a PDF.
 *
 * Four business events are built and in use, and none of them posts a journal
 * entry, because no approved chart-of-accounts mapping exists. The answers come
 * from the institution's accountant rather than from the Bank of Tanzania — so
 * unlike `OPEN-QUESTIONS.pdf`, this is not a regulatory enquiry and should not
 * queue behind one.
 *
 * `docs/05-ACCOUNTING-QUESTIONS.md` is the source of record and this renders the
 * same content for signature. `docs/04-DECISION-REGISTER.md` carries the four
 * identifiers — FEE-04, WRITEOFF-02, RECOVERY-02, RESTRUCT-04 — so an answer can
 * be recorded against the entry it settles.
 *
 * Every answer field is left blank. Nothing here proposes a treatment and no
 * account code is invented; a document that suggested an answer would get one
 * back, and it would be ours rather than the accountant's.
 *
 * Deliberately standalone rather than sharing a renderer with the open-questions
 * script. The two documents go to different readers and will drift apart in
 * layout; more immediately, factoring out a shared renderer would re-render
 * `OPEN-QUESTIONS.pdf`, and that document is not being reissued to create this
 * one. The duplicated constants below are the price, and they are constants.
 *
 *   node scripts/generate-accounting-questions-pdf.mjs [output.pdf]
 */

import { createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import PDFDocument from 'pdfkit';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUTPUT = resolve(ROOT, process.argv[2] ?? 'docs/ACCOUNTING-QUESTIONS.pdf');

/** A4 portrait, in points. */
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

/** Width of the answer column, and of the rule the accountant writes on. */
const ANSWER_WIDTH = 168;

/**
 * The BOT lines these questions touch.
 *
 * Reproduced exactly as they appear in the MSP2 template supplied by the product
 * owner (`apps/api/assets/BOT-MSP2-template.xlsx`). Sno 14's wording — "NOT
 * PROVIDED FOR" — is the reason the write-off question asks for a treatment per
 * scenario rather than one journal.
 */
const BOT_LINES = [
  ['14', '4. BAD DEBTS WRITTEN OFF NOT PROVIDED FOR'],
  ['15', '5. PROVISION FOR BAD AND DOUBTFUL DEBTS'],
  ['18', 'b. Fees (under 6. NON-INTEREST INCOME)'],
  ['21', 'e. Income from Recovery of Charged off Assets and Acquired Assets'],
];

/**
 * One block per unresolved decision.
 *
 * `event` is the transaction in plain accounting language. `example` is a
 * concrete TZS case, so no figure has to be imagined. `current` is what the
 * system records today, which is the part that constrains what an answer can
 * assume. `asks` are the blanks to fill in.
 */
const QUESTIONS = [
  {
    ref: 'FEE-04',
    title: 'Application/form fee',
    event:
      'A TZS 5,000 application fee is collected in cash when a borrower submits loan forms. ' +
      'It is charged once per application, not once per submission. If the application is ' +
      'approved the institution retains it. If the application is formally rejected the ' +
      'applicant becomes entitled to a refund, and a refund is recorded only when staff ' +
      'physically hand the cash back. Revising and resubmitting the same application never ' +
      'incurs a second fee.',
    example:
      'A borrower submits forms on 3 February and pays TZS 5,000 in cash. On 20 February the ' +
      'application is rejected. On 24 February a cashier hands TZS 5,000 back and records it. ' +
      'The applicant revises and resubmits on 3 March — no further fee is charged.',
    current:
      'The collection is recorded with date, method, reference and the staff member who took ' +
      'it. State is derived as collected → retained, or refund_due → refunded. A refund is a ' +
      'second event; the original collection record is never deleted or amended. No journal ' +
      'entry is written, and no screen states or implies that one is.',
    decision:
      'The fee may later be retained or refunded depending on the credit decision. Please ' +
      'specify the accounting treatment from collection through final retention or refund.',
    asks: [
      'Debit account — on collection',
      'Credit account — on collection',
      'Debit account — on retention, if a further entry is required',
      'Credit account — on retention, if a further entry is required',
      'Debit account — on refund',
      'Credit account — on refund',
      'Recognition timing — at which point or points does an entry arise?',
      'Treatment of any previously recognised balance',
      'Additional treatment/entry — should MSP2-02 Sno 18 be fed from these records, and on what basis?',
      'Accountant notes',
    ],
  },
  {
    ref: 'WRITEOFF-02',
    title: 'Loan written off',
    event:
      'An owner or manager judges a debt no longer realistically recoverable and writes it ' +
      'off. There is no automatic days-overdue trigger — it is always a person’s decision, ' +
      'with a stated reason. The borrower’s live outstanding balance becomes zero and future ' +
      'interest and penalties stop accruing. All original financial information and history ' +
      'are preserved.',
    example:
      'Loan LN-0001 carries outstanding principal TZS 720,000, unpaid accrued interest ' +
      'TZS 38,000 and accrued penalties TZS 12,000. On 15 June the manager writes it off, ' +
      'recording the reason. The borrower’s live balance becomes 0.00 and the loan stops ' +
      'accruing.',
    current:
      'The write-off record captures the components separately, at the instant of the ' +
      'decision and before the live balance is zeroed — principal and penalties are each held ' +
      'as their own figure rather than a single total, so a treatment that distinguishes them ' +
      'can be applied afterwards. The loan moves to written_off and refuses further ordinary ' +
      'repayments. No journal entry is written.',
    decision:
      'BOT distinguishes Sno 14 (written off not provided for) from Sno 15 (provision). ' +
      'Please specify treatment per scenario rather than a single journal, and note that the ' +
      'system holds no posted provision balance today. The three components may attract ' +
      'different treatment, so each is asked about separately.',
    asks: [
      'Debit account — portion NOT previously provided for',
      'Credit account — portion NOT previously provided for',
      'Debit account — portion previously provided for',
      'Credit account — portion previously provided for',
      'Principal (720,000) — treatment',
      'Unpaid accrued interest (38,000) — if unpaid accrued interest exists at write-off, is it part of the write-off amount? If yes, specify its debit/credit treatment and whether previously recognised interest income must be reversed or otherwise adjusted.',
      'Penalties (12,000) — same treatment as principal, or reversed against the income they were accrued into?',
      'Recognition timing — at the manager’s decision, at period end, or on another trigger?',
      'Treatment of any previously recognised provision — is it released, and against which account?',
      'Additional treatment/entry — should the system begin creating and posting a provision balance, so there is something to release?',
      'Accountant notes',
    ],
    footnote:
      'The implemented write-off behaviour is not changed by asking this. Whatever the answer, ' +
      'the operational record already keeps the components apart, so the approved treatment can ' +
      'be applied to write-offs that have already happened.',
  },
  {
    ref: 'RECOVERY-02',
    title: 'Money recovered after write-off',
    event:
      'A borrower pays something after their loan has been written off. This is not a ' +
      'repayment: the debt is already off the books, the loan is not reinstated, its status ' +
      'stays written_off, and the borrower’s live balance stays zero. Partial and repeated ' +
      'recoveries are both ordinary.',
    example:
      'Following the write-off above, the borrower pays TZS 150,000 in cash on 1 August. Loan ' +
      'LN-0001 remains written_off and the borrower’s live balance remains 0.00.',
    current:
      'Recoveries are held in their own table with amount, date, method, reference, note, loan ' +
      'and recording user. They are deliberately never written as payments, so they cannot be ' +
      'counted as repayment or interest income. No journal entry is written, and MSP2-02 ' +
      'Sno 21 is not yet fed from these records.',
    decision:
      'BOT identifies recovery of previously written-off assets as income (Sno 21). The ledger ' +
      'posting is not established.',
    asks: [
      'Debit account',
      'Credit account',
      'Recognition timing — on receipt of cash, or at another point?',
      'Treatment of previously recognised balance — does a recovery reverse any part of the earlier write-off entry, or stand alone?',
      'Additional treatment/entry — should MSP2-02 Sno 21 be fed from these records, and on what basis?',
      'If recoveries against one loan ever exceed the amount originally written off, what treatment applies to the excess?',
      'Accountant notes',
    ],
  },
  {
    ref: 'RESTRUCT-04',
    title: 'Capitalisation on restructuring',
    event:
      'A loan is restructured into a successor loan. The old loan is preserved for audit, ' +
      'keeps its schedule and payments, and stops accepting repayments. The successor’s ' +
      'principal is remaining principal + unpaid accrued interest + unpaid penalties. No cash ' +
      'is disbursed as part of the restructuring. Interest subsequently accrues on the ' +
      'approved successor principal, including the capitalised amounts.',
    example:
      'Remaining principal TZS 600,000 + unpaid accrued interest TZS 50,000 + unpaid ' +
      'penalties TZS 20,000 = successor principal TZS 670,000. No money moves. Interest then ' +
      'accrues on TZS 670,000.',
    current:
      'The restructuring record keeps the three components separately — principal carried, ' +
      'interest capitalised and penalties capitalised — because a total cannot be decomposed ' +
      'after the fact. The link between the old loan and its successor is recorded in both ' +
      'directions. No journal entry is written.',
    aside:
      'Restructuring is built and tested but is currently withheld from staff for a separate ' +
      'and unrelated Bank of Tanzania question (RESTRUCT-06, on whether a restructured ' +
      'facility counts as a disbursement for MSP2-09). The answer below is still needed and ' +
      'does not depend on that one.',
    decision:
      'Please answer the first question before the rest — the remaining questions only arise ' +
      'if a journal entry is required.',
    asks: [
      'Does replacing the old loan receivable with the successor require a journal reclassification/transfer, or should the remaining principal receivable simply continue operationally under the successor loan without a separate journal entry?',
      'If a journal entry is required — debit account for the principal carried (600,000)',
      'If a journal entry is required — credit account for the principal carried (600,000)',
      'Debit account — capitalised interest (50,000)',
      'Credit account — capitalised interest (50,000)',
      'Debit account — capitalised penalties (20,000)',
      'Credit account — capitalised penalties (20,000)',
      'Recognition timing — at approval of the restructuring, or at the successor’s effective date?',
      'Treatment of previously recognised balance — were the interest and penalties already recognised as income when accrued, and does capitalisation change that recognition?',
      'Additional treatment/entry',
      'Accountant notes',
    ],
  },
];

/** What has to come back before any of this can be built. */
const NEEDED = [
  'FEE-04 — the account pair at collection; whether a further pair applies at retention; the ' +
    'account pair at refund; the point or points at which an entry arises; and whether ' +
    'MSP2-02 Sno 18 should be fed from these records.',
  'WRITEOFF-02 — account pairs for both the provided-for and not-provided-for portions; ' +
    'separate treatment for principal, unpaid accrued interest and penalties, including ' +
    'whether unpaid accrued interest forms part of the write-off amount and whether ' +
    'previously recognised interest income must be reversed or adjusted; the recognition ' +
    'trigger; and whether the system should begin posting a provision balance at all, since ' +
    'none exists today.',
  'RECOVERY-02 — the account pair; whether a recovery stands alone or reverses part of the ' +
    'write-off; whether Sno 21 should be fed from these records; and the treatment where ' +
    'recoveries exceed the amount originally written off.',
  'RESTRUCT-04 — first, whether replacing the old receivable with the successor is an ' +
    'accounting event at all. Then, if it is, the account pairs for the principal carried; in ' +
    'either case the account pairs for capitalised interest and capitalised penalties; the ' +
    'recognition point; and whether those amounts were already recognised as income when ' +
    'accrued.',
  'The cross-cutting decision, which shapes all four: should these events post journal ' +
    'entries automatically, or should they continue to be recorded operationally with an ' +
    'accountant making the entries manually? This must be answered explicitly. Today MSP2-02 ' +
    'is compiled from manually entered finance entries. If automatic posting is wanted, we ' +
    'need the account mapping above. If manual entry is acceptable, the operational records ' +
    'already carry everything needed and no code change is required.',
  'A chart of accounts — or at minimum the account names and codes for every account named ' +
    'in the answers. No account code will be invented on your behalf.',
];

const FOOTNOTE =
  'Prepared from docs/05-ACCOUNTING-QUESTIONS.md, which is the source of record. The four ' +
  'identifiers are carried in docs/04-DECISION-REGISTER.md, where all four remain BLOCKED BY ' +
  'ACCOUNTING POLICY. Nothing in this document is a proposed answer: until these are settled ' +
  'each event is recorded and traced operationally with no journal entry, and no screen ' +
  'states or implies that anything has been posted.';

function main() {
  const document = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: {
      Title: 'MFI Manager — accounting policy decisions required',
      Author: 'MFI Manager',
      Subject: 'Four recorded business events awaiting a chart-of-accounts mapping',
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
      .text(
        `MFI Manager — accounting policy decisions · page ${String(pageNumber)}`,
        MARGIN,
        PAGE.height - MARGIN,
        { width: CONTENT_WIDTH, align: 'right', lineBreak: false },
      );
    document.y = MARGIN;
  };

  /** Start a new page when `needed` points will not fit on this one. */
  const reserve = (needed) => {
    if (document.y + needed > BOTTOM) {
      newPage();
    }
  };

  const paragraph = (text, { font = FONT, size = 9.5, colour = INK, gap = 0.5 } = {}) => {
    const height = document.font(font).fontSize(size).heightOfString(text, {
      width: CONTENT_WIDTH,
    });
    reserve(height);
    document.font(font).fontSize(size).fillColor(colour).text(text, MARGIN, document.y, {
      width: CONTENT_WIDTH,
    });
    document.moveDown(gap);
  };

  /** A labelled paragraph: bold lead-in, then the body on the same block. */
  const labelled = (label, text) => {
    const height =
      document.font(FONT_BOLD).fontSize(9.5).heightOfString(label, { width: CONTENT_WIDTH }) +
      document.font(FONT).fontSize(9.5).heightOfString(text, { width: CONTENT_WIDTH });
    reserve(height);

    document.font(FONT_BOLD).fontSize(9.5).fillColor(ACCENT).text(label, MARGIN, document.y, {
      width: CONTENT_WIDTH,
    });
    document.font(FONT).fontSize(9.5).fillColor(INK).text(text, MARGIN, document.y, {
      width: CONTENT_WIDTH,
    });
    document.moveDown(0.5);
  };

  /**
   * One question and the rule its answer is written on.
   *
   * The prompt wraps in the left column and the rule sits at the right, so a
   * long question does not squeeze the space to answer it.
   */
  const answerRow = (prompt) => {
    const promptWidth = CONTENT_WIDTH - ANSWER_WIDTH - 14;
    const height = Math.max(
      document.font(FONT).fontSize(9).heightOfString(prompt, { width: promptWidth }),
      14,
    );
    reserve(height + 8);

    const top = document.y;
    document
      .font(FONT)
      .fontSize(9)
      .fillColor(INK)
      .text(prompt, MARGIN, top, { width: promptWidth });

    const ruleY = top + height - 3;
    document
      .moveTo(MARGIN + promptWidth + 14, ruleY)
      .lineTo(MARGIN + CONTENT_WIDTH, ruleY)
      .lineWidth(0.6)
      .strokeColor(RULE)
      .stroke();

    document.y = top + height + 8;
  };

  const divider = () => {
    reserve(16);
    document
      .moveTo(MARGIN, document.y)
      .lineTo(MARGIN + CONTENT_WIDTH, document.y)
      .lineWidth(0.8)
      .strokeColor(RULE)
      .stroke();
    document.y += 12;
  };

  // ---- Cover ----------------------------------------------------------------
  newPage();

  document
    .font(FONT_BOLD)
    .fontSize(19)
    .fillColor(INK)
    .text('Accounting policy decisions required', MARGIN, document.y, { width: CONTENT_WIDTH });
  document.moveDown(0.3);
  document
    .font(FONT)
    .fontSize(11)
    .fillColor(MUTED)
    .text('MFI Manager — four recorded events awaiting a chart-of-accounts mapping', {
      width: CONTENT_WIDTH,
    });
  document.moveDown(0.6);

  document
    .moveTo(MARGIN, document.y)
    .lineTo(MARGIN + CONTENT_WIDTH, document.y)
    .lineWidth(1)
    .strokeColor(ACCENT)
    .stroke();
  document.moveDown(1);

  paragraph(
    `${String(QUESTIONS.length)} business events are built, tested and in operational use. ` +
      'Each records what happened and preserves the underlying figures, but none posts a ' +
      'journal entry, because no approved chart-of-accounts mapping exists for them.',
  );
  paragraph(
    'Nothing below proposes a treatment, and no account code is invented. Each question is ' +
      'asked because the answer cannot be derived from any document supplied to the project, ' +
      'and guessing it would put a figure in the accounts that nobody decided.',
    { font: FONT_ITALIC, size: 9, colour: MUTED, gap: 1 },
  );

  labelled(
    'Two facts about the system that bear on your answers.  ',
    '1. MSP2-02 is compiled from manually entered finance entries, each keyed to a BOT line ' +
      'number; none of the four events below posts to it automatically today. 2. Provisions ' +
      'are not a ledger balance — the system computes provisioning rates from BOT’s ' +
      'classification schedule for MSP2-03 reporting only, so there is no posted provision ' +
      'account for a write-off to release. If an answer assumes one exists, please say what ' +
      'should create it.',
  );

  document.moveDown(0.4);
  paragraph(
    'Relevant BOT MSP2-02 reporting lines, reproduced as they appear in the MSP2 template ' +
      'supplied by the product owner (apps/api/assets/BOT-MSP2-template.xlsx):',
    { size: 9, colour: MUTED },
  );

  for (const [sno, label] of BOT_LINES) {
    reserve(14);
    const top = document.y;
    document.font(FONT_BOLD).fontSize(9).fillColor(ACCENT).text(`Sno ${sno}`, MARGIN, top, {
      width: 44,
      lineBreak: false,
    });
    document
      .font(FONT)
      .fontSize(9)
      .fillColor(INK)
      .text(label, MARGIN + 50, top, { width: CONTENT_WIDTH - 50 });
    document.y = Math.max(document.y, top + 13);
  }

  document.moveDown(1);

  // ---- One block per decision ----------------------------------------------
  for (const question of QUESTIONS) {
    divider();

    reserve(40);
    document
      .font(FONT_BOLD)
      .fontSize(12.5)
      .fillColor(INK)
      .text(`${question.ref} — ${question.title}`, MARGIN, document.y, { width: CONTENT_WIDTH });
    document.moveDown(0.5);

    labelled('Business event.  ', question.event);
    labelled('Example.  ', question.example);
    labelled('Current system behaviour.  ', question.current);

    if (question.aside !== undefined) {
      paragraph(question.aside, { font: FONT_ITALIC, size: 9, colour: MUTED });
    }

    labelled('Accounting decision required.  ', question.decision);
    document.moveDown(0.3);

    for (const ask of question.asks) {
      answerRow(ask);
    }

    if (question.footnote !== undefined) {
      document.moveDown(0.2);
      paragraph(question.footnote, { font: FONT_ITALIC, size: 8.5, colour: MUTED });
    }
  }

  // ---- What we need back ----------------------------------------------------
  divider();

  reserve(30);
  document
    .font(FONT_BOLD)
    .fontSize(12.5)
    .fillColor(INK)
    .text('Information we need back', MARGIN, document.y, { width: CONTENT_WIDTH });
  document.moveDown(0.5);

  let index = 0;
  for (const item of NEEDED) {
    index += 1;
    const height = document
      .font(FONT)
      .fontSize(9)
      .heightOfString(item, {
        width: CONTENT_WIDTH - 20,
      });
    reserve(height + 6);

    const top = document.y;
    document
      .font(FONT_BOLD)
      .fontSize(9)
      .fillColor(ACCENT)
      .text(`${String(index)}.`, MARGIN, top, { width: 16, lineBreak: false });
    document
      .font(FONT)
      .fontSize(9)
      .fillColor(INK)
      .text(item, MARGIN + 20, top, { width: CONTENT_WIDTH - 20 });
    document.y += 6;
  }

  document.moveDown(1);
  reserve(50);
  document
    .moveTo(MARGIN, document.y)
    .lineTo(MARGIN + CONTENT_WIDTH, document.y)
    .lineWidth(0.8)
    .strokeColor(RULE)
    .stroke();
  document.moveDown(0.6);
  document
    .font(FONT_ITALIC)
    .fontSize(8.5)
    .fillColor(MUTED)
    .text(FOOTNOTE, MARGIN, document.y, { width: CONTENT_WIDTH });

  document.end();

  stream.on('finish', () => {
    process.stdout.write(`Wrote ${OUTPUT}\n`);
  });
}

main();
