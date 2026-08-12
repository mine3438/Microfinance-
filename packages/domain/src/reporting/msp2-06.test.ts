import { Money } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import {
  COMPLAINT_LINE,
  compileMsp2_06,
  type ComplaintLineLabel,
  type ComplaintRecord,
  type Msp2_06,
} from './msp2-06.js';
import { reportingPeriod } from './period.js';

/**
 * MSP2-06's roll-forward, and the dates that decide it.
 *
 * The property under test throughout is that **every line comes from the same
 * records read at different moments**. Nothing is carried forward, so restating
 * a quarter is a matter of asking again with different dates — and a complaint
 * moves between lines because its dates say so, never because somebody typed a
 * new opening figure.
 */

const NATURES = [
  'interest_rate',
  'agreements',
  'repayments',
  'loan_statement',
  'loan_processing',
  'others',
];

const LABELS: ComplaintLineLabel[] = [
  { sno: 1, label: 'Number of complaints at the beginning of the quarter', isComputed: false },
  { sno: 2, label: 'New complaints received during the quarter', isComputed: false },
  { sno: 3, label: 'Complaints resolved during the quarter by the institution', isComputed: false },
  { sno: 4, label: 'Complaints resolved during the quarter by other parties', isComputed: false },
  { sno: 5, label: 'Unresolved complaints at the end of the quarter', isComputed: true },
  { sno: 6, label: 'Unresolved complaints referred to Bank of Tanzania', isComputed: false },
  {
    sno: 7,
    label: 'Unresolved complaints referred to Fair Competition Commission',
    isComputed: false,
  },
  { sno: 8, label: 'Unresolved complaints referred to Courts', isComputed: false },
  { sno: 9, label: 'Unresolved complaints referred to Other Parties', isComputed: false },
];

/** 2026 Q2: 1 April to 30 June. */
const PERIOD = reportingPeriod(2026, 2);

function complaint(overrides: Partial<ComplaintRecord> = {}): ComplaintRecord {
  return {
    natureCode: 'repayments',
    amount: Money.of('100000.00'),
    receivedOn: '2026-05-10',
    resolvedOn: null,
    resolvedBy: null,
    referredTo: null,
    referredOn: null,
    ...overrides,
  };
}

const compile = (complaints: readonly ComplaintRecord[]): Msp2_06 =>
  compileMsp2_06({ period: PERIOD, natureCodes: NATURES, complaints }, LABELS);

const line = (form: Msp2_06, sno: number): Msp2_06['rows'][number] => {
  const row = form.rows.find((candidate) => candidate.sno === sno);
  if (row === undefined) {
    throw new Error(`No line ${String(sno)}`);
  }
  return row;
};

describe('compileMsp2_06', () => {
  it('produces BOT’s nine lines in order', () => {
    const form = compile([]);

    expect(form.rows.map((row) => row.sno)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(form.rows.every((row) => row.count === 0)).toBe(true);
  });

  it('counts a complaint raised before the quarter and still open as opening', () => {
    const form = compile([complaint({ receivedOn: '2025-11-02' })]);

    expect(line(form, COMPLAINT_LINE.opening).count).toBe(1);
    expect(line(form, COMPLAINT_LINE.received).count).toBe(0);
    expect(line(form, COMPLAINT_LINE.unresolvedAtEnd).count).toBe(1);
  });

  it('does not count a complaint resolved before the quarter began', () => {
    const form = compile([
      complaint({ receivedOn: '2025-11-02', resolvedOn: '2026-01-14', resolvedBy: 'institution' }),
    ]);

    // Closed before this quarter opened: it belongs to a previous return and
    // appears on no line of this one.
    expect(form.rows.every((row) => row.count === 0)).toBe(true);
  });

  it('separates the two resolution routes BOT distinguishes', () => {
    const form = compile([
      complaint({ resolvedOn: '2026-06-01', resolvedBy: 'institution' }),
      complaint({ resolvedOn: '2026-06-02', resolvedBy: 'other_party' }),
      complaint({ resolvedOn: '2026-06-03', resolvedBy: 'other_party' }),
    ]);

    expect(line(form, COMPLAINT_LINE.resolvedByInstitution).count).toBe(1);
    expect(line(form, COMPLAINT_LINE.resolvedByOtherParties).count).toBe(2);
  });

  it('satisfies BOT’s roll-forward without computing it', () => {
    // Every case that could break the identity: opened before and closed
    // inside, opened and closed inside, opened inside and left open, opened
    // before and left open, and one closed after the quarter ends.
    const form = compile([
      complaint({ receivedOn: '2025-12-01', resolvedOn: '2026-04-20', resolvedBy: 'institution' }),
      complaint({ receivedOn: '2026-04-02', resolvedOn: '2026-05-05', resolvedBy: 'other_party' }),
      complaint({ receivedOn: '2026-05-30' }),
      complaint({ receivedOn: '2025-06-06' }),
      complaint({ receivedOn: '2026-06-29', resolvedOn: '2026-07-04', resolvedBy: 'institution' }),
    ]);

    const rollForward =
      line(form, COMPLAINT_LINE.opening).count +
      line(form, COMPLAINT_LINE.received).count -
      line(form, COMPLAINT_LINE.resolvedByInstitution).count -
      line(form, COMPLAINT_LINE.resolvedByOtherParties).count;

    // Line 5 is derived from the records, not from the arithmetic above. That
    // the two agree is the identity BOT's rule 8 asserts.
    expect(line(form, COMPLAINT_LINE.unresolvedAtEnd).count).toBe(rollForward);
    expect(line(form, COMPLAINT_LINE.unresolvedAtEnd).count).toBe(3);
  });

  it('counts a referral only once it has been made', () => {
    const form = compile([
      complaint({ referredTo: 'courts', referredOn: '2026-06-20' }),
      // Referred after the quarter ended: a fact about the next return.
      complaint({ referredTo: 'courts', referredOn: '2026-07-01' }),
    ]);

    expect(line(form, COMPLAINT_LINE.referredToCourts).count).toBe(1);
    expect(line(form, COMPLAINT_LINE.unresolvedAtEnd).count).toBe(2);
  });

  it('does not count a referral on a complaint that has since been resolved', () => {
    const form = compile([
      complaint({
        referredTo: 'bank_of_tanzania',
        referredOn: '2026-04-10',
        resolvedOn: '2026-05-01',
        resolvedBy: 'other_party',
      }),
    ]);

    // BOT's lines 6 to 9 count *unresolved* complaints referred somewhere.
    expect(line(form, COMPLAINT_LINE.referredToBot).count).toBe(0);
    expect(line(form, COMPLAINT_LINE.resolvedByOtherParties).count).toBe(1);
  });

  it('splits every line across BOT’s six natures, and the split sums to the count', () => {
    const form = compile([
      complaint({ natureCode: 'interest_rate' }),
      complaint({ natureCode: 'interest_rate' }),
      complaint({ natureCode: 'others' }),
    ]);

    const row = line(form, COMPLAINT_LINE.received);
    expect(row.byNature.get('interest_rate')).toBe(2);
    expect(row.byNature.get('others')).toBe(1);
    // A column per published category, including the empty ones.
    expect([...row.byNature.keys()]).toEqual(NATURES);
    // Rule 7, by construction.
    expect([...row.byNature.values()].reduce((sum, count) => sum + count, 0)).toBe(row.count);
  });

  it('sums the value over the same complaints it counts', () => {
    const form = compile([
      complaint({ amount: Money.of('250000.50') }),
      complaint({ amount: Money.of('749999.50') }),
      // A complaint about a loan statement need not be about money.
      complaint({ amount: Money.zero() }),
    ]);

    const row = line(form, COMPLAINT_LINE.received);
    expect(row.count).toBe(3);
    expect(row.value.toString()).toBe('1000000.00');
  });

  it('refuses a nature BOT does not publish', () => {
    expect(() => compile([complaint({ natureCode: 'staff_conduct' })])).toThrow(
      DomainValidationError,
    );
  });

  it('refuses to compile without the nature taxonomy', () => {
    expect(() =>
      compileMsp2_06({ period: PERIOD, natureCodes: [], complaints: [] }, LABELS),
    ).toThrow(DomainValidationError);
  });

  it('refuses a line it does not know how to derive', () => {
    expect(() =>
      compileMsp2_06({ period: PERIOD, natureCodes: NATURES, complaints: [] }, [
        ...LABELS,
        { sno: 10, label: 'A line BOT has not published', isComputed: false },
      ]),
    ).toThrow(DomainValidationError);
  });
});
