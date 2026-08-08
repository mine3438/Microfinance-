import { Money, Percentage } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import {
  NON_PERFORMING_CLASSIFICATIONS,
  OVERDUE_CLASSIFICATIONS,
  classifyByDaysOverdue,
  grossProvision,
  isOverdueClassification,
  netProvision,
  nonPerformingRatio,
  type PortfolioByClassification,
  type ProvisioningBand,
} from './classification.js';

/** BOT's standard schedule, as read from the MSP2-03 sheet. */
const STANDARD: ProvisioningBand[] = [
  {
    classification: 'current',
    minDaysOverdue: 0,
    maxDaysOverdue: 5,
    provisionRate: Percentage.of('1'),
  },
  {
    classification: 'esm',
    minDaysOverdue: 6,
    maxDaysOverdue: 30,
    provisionRate: Percentage.of('5'),
  },
  {
    classification: 'substandard',
    minDaysOverdue: 31,
    maxDaysOverdue: 60,
    provisionRate: Percentage.of('25'),
  },
  {
    classification: 'doubtful',
    minDaysOverdue: 61,
    maxDaysOverdue: 90,
    provisionRate: Percentage.of('50'),
  },
  {
    classification: 'loss',
    minDaysOverdue: 91,
    maxDaysOverdue: null,
    provisionRate: Percentage.of('100'),
  },
];

/** BOT's housing schedule. Note it begins at 91 days. */
const HOUSING: ProvisioningBand[] = [
  {
    classification: 'substandard',
    minDaysOverdue: 91,
    maxDaysOverdue: 180,
    provisionRate: Percentage.of('25'),
  },
  {
    classification: 'doubtful',
    minDaysOverdue: 181,
    maxDaysOverdue: 360,
    provisionRate: Percentage.of('50'),
  },
  {
    classification: 'loss',
    minDaysOverdue: 361,
    maxDaysOverdue: null,
    provisionRate: Percentage.of('100'),
  },
];

describe('the standard schedule', () => {
  it.each([
    [0, 'current', '1'],
    [5, 'current', '1'],
    [6, 'esm', '5'],
    [30, 'esm', '5'],
    [31, 'substandard', '25'],
    [60, 'substandard', '25'],
    [61, 'doubtful', '50'],
    [90, 'doubtful', '50'],
    [91, 'loss', '100'],
    [3650, 'loss', '100'],
  ])('places %i days overdue in %s at %s%%', (days, classification, rate) => {
    const result = classifyByDaysOverdue(days, STANDARD);

    expect(result.classified).toBe(true);
    if (result.classified) {
      expect(result.classification).toBe(classification);
      expect(result.provisionRate.toString()).toBe(rate);
    }
  });

  it('stops treating a loan as current after five days', () => {
    // Far tighter than the previous documentation implied, and the single most
    // consequential band boundary: a loan is no longer Current after a working
    // week.
    const current = classifyByDaysOverdue(5, STANDARD);
    const esm = classifyByDaysOverdue(6, STANDARD);

    expect(current.classified && current.classification).toBe('current');
    expect(esm.classified && esm.classification).toBe('esm');
  });
});

describe('the housing schedule', () => {
  it('provisions a 100-day-overdue housing loan at 25% where any other loan is at 100%', () => {
    const housing = classifyByDaysOverdue(100, HOUSING);
    const standard = classifyByDaysOverdue(100, STANDARD);

    expect(housing.classified && housing.provisionRate.toString()).toBe('25');
    expect(standard.classified && standard.provisionRate.toString()).toBe('100');
  });

  it.each([0, 1, 40, 90])('cannot classify a housing loan %i days overdue', (days) => {
    // Not a defect in this code. BOT's template states three housing bands
    // beginning at 91 days and defines nothing below that (§11.5). Returning a
    // result rather than throwing keeps the gap visible so it reaches an
    // operator, instead of being absorbed into `current` — which would
    // understate provisions and file a wrong MSP2-03.
    const result = classifyByDaysOverdue(days, HOUSING);

    expect(result.classified).toBe(false);
    if (!result.classified) {
      expect(result.reason).toBe('no_band_covers_days');
      expect(result.message).toContain('§11.5');
    }
  });

  it('classifies a housing loan once it reaches 91 days', () => {
    expect(classifyByDaysOverdue(91, HOUSING).classified).toBe(true);
  });
});

describe('rejected input', () => {
  it.each([-1, 1.5, Number.NaN])('refuses %j days overdue', (days) => {
    expect(() => classifyByDaysOverdue(days, STANDARD)).toThrow(DomainValidationError);
  });

  it('refuses an empty schedule', () => {
    expect(() => classifyByDaysOverdue(10, [])).toThrow(/empty provisioning schedule/);
  });
});

describe('provisions', () => {
  const outstanding = Money.of('1234567.89');

  it.each([
    ['current', '1', '12345.68'],
    ['esm', '5', '61728.39'],
    ['substandard', '25', '308641.97'],
    ['doubtful', '50', '617283.95'],
    ['loss', '100', '1234567.89'],
  ])('holds %s at %s%%', (_class, rate, expected) => {
    expect(grossProvision(outstanding, Percentage.of(rate)).toDatabaseValue()).toBe(expected);
  });

  it('nets against collateral, as MSP2-03 line 70 requires', () => {
    const gross = grossProvision(outstanding, Percentage.of('50'));

    expect(netProvision(gross, Money.of('100000.00')).toDatabaseValue()).toBe('517283.95');
  });

  it('floors at zero when collateral exceeds the provision', () => {
    // A negative provision would add to the loan book on MSP2-01, which is the
    // opposite of what holding security means.
    const gross = grossProvision(Money.of('100000.00'), Percentage.of('1'));

    expect(netProvision(gross, Money.of('500000.00')).isZero()).toBe(true);
  });

  it('refuses a negative outstanding amount or negative collateral', () => {
    expect(() => grossProvision(Money.of('-1.00'), Percentage.of('1'))).toThrow(
      DomainValidationError,
    );
    expect(() => netProvision(Money.of('10.00'), Money.of('-1.00'))).toThrow(DomainValidationError);
  });
});

describe('the non-performing ratio', () => {
  const portfolio = (values: Record<string, string>): PortfolioByClassification => ({
    current: Money.of(values['current'] ?? '0'),
    esm: Money.of(values['esm'] ?? '0'),
    substandard: Money.of(values['substandard'] ?? '0'),
    doubtful: Money.of(values['doubtful'] ?? '0'),
    loss: Money.of(values['loss'] ?? '0'),
  });

  it('counts substandard, doubtful and loss against the gross book', () => {
    // MSP2-03 line 73, with the figures the money layer's own golden vectors use.
    const ratio = nonPerformingRatio(
      portfolio({
        current: '225000000.00',
        substandard: '12000000.00',
        doubtful: '8000000.00',
        loss: '5000000.00',
      }),
    );

    expect(ratio.toFixed(2)).toBe('10.00');
  });

  it('excludes ESM, which BOT does not count as non-performing', () => {
    const ratio = nonPerformingRatio(portfolio({ current: '900000.00', esm: '100000.00' }));

    expect(ratio.toFixed(2)).toBe('0.00');
  });

  it('reports a fully impaired book as a hundred percent', () => {
    expect(nonPerformingRatio(portfolio({ loss: '500000.00' })).toFixed(2)).toBe('100.00');
  });

  it('reports zero for an empty book rather than dividing by it', () => {
    // A lender with no loans has no bad ones, and a division error on the
    // return would be worse than a nought.
    expect(nonPerformingRatio(portfolio({})).toFixed(2)).toBe('0.00');
  });

  it('names exactly the three classes BOT counts', () => {
    expect([...NON_PERFORMING_CLASSIFICATIONS]).toEqual(['substandard', 'doubtful', 'loss']);
  });

  it('offers the five columns MSP2-03 provides', () => {
    expect([...OVERDUE_CLASSIFICATIONS]).toEqual([
      'current',
      'esm',
      'substandard',
      'doubtful',
      'loss',
    ]);
    expect(isOverdueClassification('watchlist')).toBe(false);
  });
});
