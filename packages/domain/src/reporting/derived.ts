import { Money } from '@mfi/money';

import { type Msp2_01Derived } from './msp2-01.js';
import { type Msp2_02 } from './msp2-02.js';
import { type Msp2_03 } from './msp2-03.js';
import { type Msp2_07 } from './msp2-07.js';
import { type Msp2_08 } from './msp2-08.js';
import { type Msp2_10 } from './msp2-10.js';

/**
 * The eleven balance-sheet lines this system answers for itself.
 *
 * Read from forms already compiled rather than from the database a second time,
 * so the figure BOT sees on MSP2-01 is the same one it sees on MSP2-07,
 * MSP2-08, MSP2-03 or MSP2-02. That is what makes the cross-validation rules
 * hold rather than merely usually agree — and it is why those rules are still
 * run: they catch a regression in this mapping, which is the only way they can
 * now fail.
 *
 * This lives in the domain rather than in the API because it encodes how BOT's
 * forms relate to one another, which is the same kind of knowledge the
 * validation rules encode and belongs beside them.
 */

/** MSP2-02's Sno42, net income after tax, read on the year-to-date column. */
const NET_INCOME_AFTER_TAX_SNO = 42;

const NIL_SUBTOTAL: Msp2_07['total'] = Object.freeze({
  depositTzs: Money.zero(),
  depositForeignTzsEquivalent: Money.zero(),
  depositTotal: Money.zero(),
  borrowingTzs: Money.zero(),
  borrowingForeignTzsEquivalent: Money.zero(),
  borrowingTotal: Money.zero(),
});

export interface FormsFeedingBalanceSheet {
  readonly msp2_02: Msp2_02;
  readonly msp2_03: Msp2_03;
  readonly msp2_07: Msp2_07;
  readonly msp2_08: Msp2_08;
  readonly msp2_10: Msp2_10;
}

export function derivedBalanceSheetFigures(forms: FormsFeedingBalanceSheet): Msp2_01Derived {
  const subtotal = (kind: Msp2_07['sections'][number]['kind']): Msp2_07['total'] =>
    forms.msp2_07.sections.find((section) => section.kind === kind)?.subtotal ?? NIL_SUBTOTAL;

  const banks = subtotal('bank_tanzania');
  const msps = subtotal('microfinance_service_provider');
  const mnos = subtotal('mno');
  const abroad = subtotal('bank_abroad');

  const netIncome =
    forms.msp2_02.rows.find((row) => row.sno === NET_INCOME_AFTER_TAX_SNO)?.yearToDateAmount ??
    Money.zero();

  return {
    // Rule 14 ties MSP2-07's bank deposits to MSP2-01 Sno3, which is Sno4 plus
    // Sno5. Agent banking is the part MSP2-08 reports, so the non-agent line is
    // whatever is left of the same total.
    nonAgentBankingBalances: banks.depositTotal.minus(forms.msp2_08.total),
    agentBankingBalances: forms.msp2_08.total,
    balancesWithMsps: msps.depositTotal,
    mnoFloatBalances: mnos.depositTotal,
    loansToClients: forms.msp2_03.total.totalOutstanding,
    allowanceForProbableLosses: forms.msp2_03.total.netProvision,
    borrowingsFromBanksInTanzania: banks.borrowingTotal,
    borrowingsFromMsps: msps.borrowingTotal,
    borrowingsFromAbroad: abroad.borrowingTotal,
    compulsorySavings: forms.msp2_10.grandTotal.compulsorySavings,
    profitOrLoss: netIncome,
  };
}
