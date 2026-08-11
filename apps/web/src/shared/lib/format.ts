/**
 * Display formatting. **Nothing here computes.**
 *
 * Every function takes a value the server already decided and returns a string
 * to render. There is no addition, no multiplication, no rounding of a
 * monetary value anywhere in this app — a total shown beside a list comes from
 * the response that carried the list, and a repayment figure comes from a
 * preview endpoint.
 *
 * That rule is why `@mfi/money` is not a dependency of this package. Having an
 * arithmetic library here would make the wrong thing easy: a component summing
 * a column "just to show a total" is a second implementation of a figure the
 * institution reports to the Bank of Tanzania, and the two can disagree.
 */

/**
 * A monetary amount, grouped for reading.
 *
 * Takes the exact decimal string the API sent and inserts separators. It does
 * not parse to a number first: `Number('9007199254740993.01')` is not that
 * value, and a balance rendered through a double is wrong in the last digits
 * exactly where an accountant looks.
 */
export function formatMoney(amount: string): string {
  const negative = amount.startsWith('-');
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole = '0', fraction = '00'] = unsigned.split('.');

  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const places = fraction.padEnd(2, '0').slice(0, 2);

  return `${negative ? '−' : ''}${grouped}.${places}`;
}

/** An amount with its currency, for a heading or a total. */
export function formatMoneyWithCurrency(amount: string): string {
  return `TZS ${formatMoney(amount)}`;
}

/**
 * A monthly rate, shown as the percentage people quote.
 *
 * `0.0300` is displayed as `3% a month`. This is a change of notation, not a
 * calculation of interest — the multiplication by one hundred is the same
 * operation as moving a decimal point, and the value never re-enters any
 * financial figure.
 */
export function formatMonthlyRate(fraction: string): string {
  const [whole = '0', decimals = ''] = fraction.split('.');
  const digits = `${whole}${decimals.padEnd(4, '0')}`;
  const shifted = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  const trimmed = shifted.replace(/^0+(?=\d)/, '').replace(/\.?0+$/, '');
  return `${trimmed === '' ? '0' : trimmed}% a month`;
}

/**
 * A percentage the server already computed, trimmed for reading.
 *
 * `24.0000` becomes `24%`, `26.8242` stays `26.8242%`. Trailing zeros are
 * removed as text; nothing is rounded here. A BOT return reports rates to four
 * places and the server decided them — re-rounding in the browser would produce
 * a screen figure that differs from the filed one.
 */
export function formatPercentage(value: string): string {
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return `${trimmed === '' ? '0' : trimmed}%`;
}

/** A quarter, as `Q1 2026`. */
export function formatQuarter(year: number, quarter: number): string {
  return `Q${String(quarter)} ${String(year)}`;
}

/** A calendar date, as `31 Mar 2026`. */
export function formatDate(isoDate: string): string {
  // Shape-checked rather than split-and-hoped. Splitting `not-a-date` on the
  // hyphen yields three defined parts, so a presence check passes and the
  // arithmetic below produces `NaN a not` — garbage rendered with confidence,
  // which is worse than showing the raw value.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) {
    return isoDate;
  }

  const [, year, month, day] = match as unknown as [string, string, string, string];

  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const name = months[Number(month) - 1] ?? month;

  return `${String(Number(day))} ${name} ${year}`;
}

/** An instant, shown as a date and a time in the reader's own zone. */
export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Today, as the API wants a calendar date. */
export function today(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** A loan or client status, as a sentence-cased label. */
export function formatStatus(status: string): string {
  const words = status.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
