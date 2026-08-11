import { Money } from '@mfi/money';

import { DomainValidationError } from '../errors.js';

/**
 * MSP2-08 — Agent Banking Balances.
 *
 * The smallest form on the return: one balance per bank, from BOT's list of
 * institutions that offer agent banking, and a total that must equal MSP2-01's
 * agent-banking line (rule 15).
 *
 * Architecture §13.7 assumed this form needed an agent *transaction* table and
 * advised against building one speculatively. The template settled it — a
 * single balance column, nothing else — which is why this compiler is thirty
 * lines rather than a module (02-BOT-REPORTING-SPEC.md §7).
 */

/** One bank's agent-banking balance at the quarter end. */
export interface AgentBankingBalance {
  /** BOT's code for the institution, from the agent-banking list. */
  readonly institutionCode: string;
  readonly balance: Money;
}

export interface Msp2_08Row {
  readonly institutionCode: string;
  readonly balance: Money;
}

export interface Msp2_08 {
  readonly rows: readonly Msp2_08Row[];
  readonly total: Money;
}

export interface Msp2_08Request {
  /** Every institution BOT lists for agent banking, in the form's own order. */
  readonly institutionCodes: readonly string[];
  readonly balances: readonly AgentBankingBalance[];
}

/**
 * Compile the form.
 *
 * @throws {DomainValidationError} when a balance names an institution BOT does
 * not list for agent banking, which would have no row to sit on.
 */
export function compileMsp2_08(request: Msp2_08Request): Msp2_08 {
  if (request.institutionCodes.length === 0) {
    throw new DomainValidationError(
      'MSP2-08 cannot be compiled without the agent-banking institution list. Seed BOT ' +
        'reference data first.',
    );
  }

  const published = new Set(request.institutionCodes);
  for (const balance of request.balances) {
    if (!published.has(balance.institutionCode)) {
      throw new DomainValidationError(
        `An agent-banking balance references "${balance.institutionCode}", which is not on ` +
          'BOT’s agent-banking list.',
      );
    }
  }

  const rows = request.institutionCodes.map((institutionCode) => ({
    institutionCode,
    balance: Money.sum(
      request.balances
        .filter((balance) => balance.institutionCode === institutionCode)
        .map((balance) => balance.balance),
    ),
  }));

  return { rows, total: Money.sum(rows.map((row) => row.balance)) };
}
