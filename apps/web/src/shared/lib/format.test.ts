import { describe, expect, it } from 'vitest';

import {
  formatDate,
  formatMoney,
  formatMoneyWithCurrency,
  formatMonthlyRate,
  formatStatus,
} from './format.js';

describe('formatMoney', () => {
  it.each([
    ['0.00', '0.00'],
    ['1000.00', '1,000.00'],
    ['1500000.50', '1,500,000.50'],
    ['999.99', '999.99'],
    ['9999999999999.99', '9,999,999,999,999.99'],
  ])('renders %s as %s', (amount, expected) => {
    expect(formatMoney(amount)).toBe(expected);
  });

  it('formats without going through a JavaScript number', () => {
    // `Number('9007199254740993.01')` is not that value. A balance rendered
    // through a double is wrong in exactly the digits an accountant checks, so
    // this walks the string instead of parsing it.
    expect(formatMoney('9007199254740993.01')).toBe('9,007,199,254,740,993.01');
  });

  it('renders a reversal with a minus sign', () => {
    expect(formatMoney('-80000.00')).toBe('−80,000.00');
  });

  it('pads a value the server sent with fewer places', () => {
    expect(formatMoney('100.5')).toBe('100.50');
    expect(formatMoney('100')).toBe('100.00');
  });

  it('prefixes the currency when asked', () => {
    expect(formatMoneyWithCurrency('1200000.00')).toBe('TZS 1,200,000.00');
  });
});

describe('formatMonthlyRate', () => {
  it.each([
    ['0.0300', '3% a month'],
    ['0.0250', '2.5% a month'],
    ['0.1000', '10% a month'],
    ['0.0417', '4.17% a month'],
    ['0.0000', '0% a month'],
  ])('renders %s as %s', (fraction, expected) => {
    expect(formatMonthlyRate(fraction)).toBe(expected);
  });
});

describe('formatDate', () => {
  it('renders a calendar date', () => {
    expect(formatDate('2026-03-31')).toBe('31 Mar 2026');
  });

  it('does not shift the day through a timezone', () => {
    // `new Date('2026-01-01')` is midnight UTC, which in a zone behind UTC is
    // the previous evening. A due date that moves by a day can move a
    // repayment across a quarter boundary on a BOT return.
    expect(formatDate('2026-01-01')).toBe('1 Jan 2026');
  });

  it('returns unparseable input unchanged rather than inventing a date', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });
});

describe('formatStatus', () => {
  it('renders an underscored status as words', () => {
    expect(formatStatus('pending_approval')).toBe('Pending approval');
    expect(formatStatus('written_off')).toBe('Written off');
  });
});
