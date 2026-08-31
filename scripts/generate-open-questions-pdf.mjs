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
      'a borrower, or who may hold an account.',
    questions: [
      {
        ref: 'IDENTITY-01',
        title: 'Cross-institution staff identity',
        question:
          'May one person hold accounts at two institutions on this platform, using the ' +
          'same email address?',
        why:
          'Email addresses are the sign-in identifier and are globally unique, so today the ' +
          'second institution cannot invite someone the first has already onboarded. Relaxing ' +
          'it means one credential reaching two institutions’ data, which is a tenancy ' +
          'decision, not a convenience.',
        blocks: 'Nothing that exists. It sets whether an invitation can ever be issued twice.',
        current:
          'Refused. Email addresses are globally unique, and the second invitation is declined ' +
          'with a message saying so rather than silently creating a duplicate identity.',
        needs:
          'A yes or no. If yes, the sign-in identifier has to become the pair of email and ' +
          'institution, which is a schema change and not a setting.',
      },
    ],
  },
  {
    title: 'Questions for the institution’s accountant',
    blurb:
      'The business rule in each case is already decided and built. What is missing is only ' +
      'the journal mapping — which accounts each event posts to. None of these needs the ' +
      'Bank of Tanzania: they can be answered in-house, and until they are, the bookkeeping ' +
      'for four working features is manual.',
    questions: [
      {
        ref: 'FEE-04 · §13.8',
        title: 'Application fee — collection, retention and refund',
        question:
          'Which accounts does the TZS 5,000 application fee post to when it is collected, ' +
          'when it is retained on approval, and when it is refunded after a rejection?',
        why:
          'MSP2-02 identifies Fees under non-interest income as fees charged in day-to-day ' +
          'operations, which is where a retained fee plainly belongs. But the fee is ' +
          'refundable until the application is decided, so between collection and decision it ' +
          'is not income — it is money held.',
        blocks: 'The journal posting only. Nothing else waits on this.',
        current:
          'Every collection and refund is recorded and traceable, with the collection record ' +
          'kept intact when a refund is made. No journal entry is written and none is claimed ' +
          'on screen.',
        needs:
          'A chart-of-accounts mapping for three events: money taken, money retained as ' +
          'income, money handed back.',
      },
      {
        ref: 'WRITEOFF-02 · §13.8',
        title: 'Write-off — provided-for versus not',
        question:
          'Which accounts does a write-off post to, and does the treatment differ for the ' +
          'part already provided for?',
        why:
          'BOT distinguishes bad debts written off (MSP2-02, Sno 14) from the provision line. ' +
          'A write-off posted as though nothing had been provided would double-count the loss.',
        blocks: 'The journal posting only. Write-off itself works and is in use.',
        current:
          'The write-off record keeps principal and penalty separately and captures both at ' +
          'the instant of the decision, so either treatment can be posted afterwards against ' +
          'write-offs that have already happened.',
        needs:
          'A journal mapping, and a statement of whether the provided-for portion is treated ' +
          'differently from the rest.',
      },
      {
        ref: 'RECOVERY-02 · §13.8',
        title: 'Recovery income on a written-off loan',
        question: 'Which accounts does money recovered after a write-off post to?',
        why:
          'MSP2-02 carries a recoveries line (Sno 21). A recovery is not repayment income — ' +
          'the debt it relates to has already been written off — so posting it as a repayment ' +
          'would overstate interest income and understate recoveries.',
        blocks: 'The journal posting, and wiring MSP2-02 Sno 21 to consume these records.',
        current:
          'Recoveries are recorded in their own table with amount, date, method and loan, ' +
          'never as payments. The loan stays written off and no balance is restored.',
        needs: 'A journal mapping, and confirmation that Sno 21 is the intended line.',
      },
      {
        ref: 'RESTRUCT-04 · §13.8',
        title: 'Capitalised interest and penalties on a restructuring',
        question:
          'Which accounts does the capitalisation of unpaid interest and penalties into a new ' +
          'principal post to?',
        why:
          'Capitalising recognises as an asset what was previously an accrual. No supplied ' +
          'document establishes the entries for that.',
        blocks:
          'The journal posting. Restructuring is also withheld for a separate reason — see ' +
          'RESTRUCT-06.',
        current:
          'The restructuring record keeps principal carried, interest capitalised and ' +
          'penalties capitalised as three separate figures, because a total cannot be ' +
          'decomposed after the fact.',
        needs: 'A journal mapping for capitalisation.',
      },
    ],
  },
  {
    title: 'Questions for the Bank of Tanzania',
    blurb:
      'Each of these decides a figure on a filed return. Where the answer is unknown the ' +
      'system either refuses to guess or requires the caller to state the assumption ' +
      'explicitly, so that no return is compiled on an invented rule.',
    questions: [
      {
        ref: 'GROUP-05 · §13.6',
        title: 'How a group loan is reported',
        question:
          'On MSP2-03, MSP2-09 and MSP2-10, what sector, gender, age band and district does ' +
          'a loan report when the borrower is a group rather than a person?',
        why:
          'Every exposure query reaches those four attributes through the individual borrower ' +
          'on the loan. A group has no single sector, gender, age or district, so a group loan ' +
          'would be silently dropped from all three forms — understating the loan book on a ' +
          'filed return.',
        blocks:
          'Lending to a group. The liability model itself is decided: the group is the ' +
          'borrower, liability is joint, one disbursement, one schedule, one balance.',
        current:
          'Groups and membership are built and in use as an administrative record. The loans ' +
          'table is untouched — there is no group borrower and no endpoint that lends to one — ' +
          'so no group loan can exist to be misreported.',
        needs:
          'Either the four attributes for a group borrower, or a rule for deriving them from ' +
          'the membership, or confirmation that group loans report on a different basis.',
      },
      {
        ref: 'RESTRUCT-06 · §13.8',
        title: 'Is a restructured facility a disbursement?',
        question:
          'Does MSP2-09 count a restructured facility as a disbursement in the quarter it ' +
          'takes effect, when no cash moves?',
        why:
          'MSP2-09 counts every loan whose disbursement date falls in the quarter. A ' +
          'restructuring creates a successor loan carrying a disbursement date, but no money ' +
          'leaves the institution — so counting it would overstate lending.',
        blocks:
          'Putting restructuring in front of staff. The operation itself is built and tested.',
        current:
          'Restructuring is withheld rather than exposed. The endpoints are not mounted unless ' +
          'a deployment sets RESTRUCTURING_ENABLED, which defaults to off, so they answer as ' +
          'an unknown path — absent, not merely forbidden. There is no screen for it. The ' +
          'restructuring link is recorded, so any facility already restructured stays ' +
          'identifiable and can be excluded retrospectively once this is answered.',
        needs:
          'A yes or no. This is the single question standing between a finished, tested ' +
          'feature and production use.',
      },
      {
        ref: 'BOT-FORMAT-01A',
        title: 'MSP2-04 rate cells where there is no lending',
        question:
          'Should an MSP2-04 interest-rate cell be reported as 0 or left blank when the ' +
          'institution did no lending of that type in the quarter?',
        why:
          'They are not the same statement. Writing 0 asserts that lending took place at a ' +
          'rate of zero per cent; blank says there was none to report.',
        blocks: 'Nothing else. It is a presentation rule for one form.',
        current:
          'Left blank, because a blank cell cannot be misread as a claim about a rate, and 0 ' +
          'can.',
        needs: 'A ruling on which the Bank expects.',
      },
      {
        ref: 'BOT-11.2',
        title: 'Rate annualisation',
        question:
          'Is an annualised rate the simple monthly rate times twelve, or the effective rate ' +
          'compounded?',
        why:
          'On a 3% monthly rate the two differ by more than six percentage points — 36% simple ' +
          'against 42.58% effective. That difference is reported to the Bank.',
        blocks: 'Nothing. The convention is an explicit parameter rather than a hidden choice.',
        current:
          'Simple annualisation by default, and the convention used is echoed on the form ' +
          'alongside the figure, so a reader can see which was applied.',
        needs: 'A ruling naming the convention.',
      },
      {
        ref: 'BOT-11.4',
        title: 'Age-band reference date',
        question:
          'Is a borrower’s age band taken at the reporting date, at disbursement, or at some ' +
          'other date?',
        why:
          'A borrower who turns 36 during a quarter falls in a different band depending on ' +
          'which date is used, and MSP2-10 reports by band.',
        blocks: 'Nothing. The date is a required argument, never defaulted.',
        current:
          'The caller must state the reference date. Nothing assumes one, so a return cannot ' +
          'be compiled on an unstated assumption.',
        needs: 'The date the Bank intends.',
      },
      {
        ref: 'BOT-11.5',
        title: 'Housing loans under 91 days overdue',
        question: 'How is a housing loan classified when it is between 0 and 90 days overdue?',
        why:
          'BOT’s housing provisioning schedule begins at 91 days and defines nothing below ' +
          'it. There is no Current column on the form for such a loan.',
        blocks: 'Nothing. Such loans are surfaced rather than placed.',
        current:
          'Left unclassified and reported as a refusal, with the loans named. They are never ' +
          'folded into Current, because no published schedule puts them there.',
        needs: 'The classification and provisioning rate for that band.',
      },
      {
        ref: 'BOT-11.8 · BOT-11.8B',
        title: 'Fiscal year for the year-to-date column',
        question:
          'Does the year-to-date column run from the calendar year or the institution’s ' +
          'fiscal year? And must a fiscal year begin on a quarter boundary?',
        why:
          'A fiscal year starting in a month that is not a quarter boundary produces a ' +
          'year-to-date window that does not align with the quarters being reported.',
        blocks: 'Nothing. The window is a required parameter and is echoed on the return.',
        current:
          'The caller states the start of the window, and the value used is reported back as ' +
          'part of the return. Any month is accepted; a non-aligned year produces a window ' +
          'that is stated rather than silently adjusted.',
        needs: 'Which year governs, and whether a non-quarter start is permitted.',
      },
      {
        ref: 'AUDIT-01',
        title: 'Audit retention period',
        question:
          'How long must audit records be retained, and is there a maximum beyond which they ' +
          'must be destroyed?',
        why:
          'Retention is a supervisory requirement. Deleting too early destroys evidence; ' +
          'keeping data that must be destroyed is its own breach.',
        blocks: 'Nothing. Retention is simply not implemented.',
        current:
          'Nothing is ever deleted. The audit table has no update or delete policy for any ' +
          'role, so entries cannot be amended or removed even by the application.',
        needs:
          'The retention period. Note that keeping everything is the safe default and is the ' +
          'current behaviour.',
      },
    ],
  },
];
/**
 * How many questions, and how many register entries they carry.
 *
 * Counted rather than written down. The previous cover said “Twelve questions,
 * carrying thirty-one entries” long after six of them had been answered — a
 * document that misstates its own size invites doubt about the rest of it.
 */
const QUESTION_COUNT = SECTIONS.reduce((total, section) => total + section.questions.length, 0);

const ENTRY_COUNT = SECTIONS.flatMap((section) => section.questions).reduce(
  (total, question) =>
    total +
    question.ref.split(' · ').filter((part) => /^[A-Z][A-Z0-9.-]*$/.test(part.trim())).length,
  0,
);

const FOOTNOTE =
  'Prepared from docs/04-DECISION-REGISTER.md, which remains the authoritative list and ' +
  'carries every identifier used here. Nothing in this ' +
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
      Subject: 'Decisions still required, and what each one holds back',
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
    .text('MFI Manager — decisions still required, and what each one holds back', {
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
      `${String(QUESTION_COUNT)} questions, carrying ${String(ENTRY_COUNT)} entries in the ` +
        'decision register. Each one holds back a figure, a posting or an operation on a ' +
        'system that moves real money, and none can be answered from the supplied ' +
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
