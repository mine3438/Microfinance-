import {
  type CompiledReturn,
  type Msp2_02,
  type Msp2_03,
  type Msp2_04,
  type Msp2_07,
  type Msp2_08,
  type Msp2_09,
  type Msp2_10,
} from '@mfi/contracts';
import { useState, type ReactNode } from 'react';

import {
  formatDate,
  formatMoney,
  formatPercentage,
  formatStatus,
} from '../../shared/lib/format.js';
import { Panel } from '../../shared/ui/panel.js';

/**
 * The four MSP2 forms this system compiles, rendered.
 *
 * Every figure is printed exactly as the API sent it. Nothing on this screen
 * adds a column, derives a total, or converts a rate — a total shown beneath a
 * table is the total the server computed, because a second implementation of a
 * figure an institution files with its regulator is a second answer waiting to
 * disagree with the first.
 *
 * Empty rows are kept. BOT's templates have a fixed number of rows read by
 * position, so a sector with no lending is a row of zeros rather than an absent
 * one, and hiding them here would show the operator a different document from
 * the one being filed.
 */

/** A rate band cell, which is blank rather than zero when nothing applies. */
function Rate({ value }: { value: string | null }): ReactNode {
  // Distinguished from zero on purpose: a loan type with no straight-line
  // lending has no lowest rate, and printing 0% would say it lends at nothing.
  return value === null ? <span className="muted">—</span> : <>{formatPercentage(value)}</>;
}

/** How BOT labels each section of MSP2-07. */
const SECTION_LABELS: Record<Msp2_07['sections'][number]['kind'], string> = {
  bank_tanzania: 'Banks in Tanzania',
  microfinance_service_provider: 'Microfinance service providers',
  mno: 'Mobile network operators',
  bank_abroad: 'Banks abroad',
};

export function Msp2_02Table({ form }: { form: Msp2_02 }): ReactNode {
  return (
    <Panel title="MSP2-02 — Statement of income and expense">
      <p className="hint-block">
        Year to date covers {formatDate(form.yearToDateFrom)} to {formatDate(form.yearToDateTo)}.
        Whether BOT reads that year as the calendar year or the institution&rsquo;s own is
        unconfirmed (§11.8), so the window used is stated rather than assumed.
      </p>

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Sno</th>
              <th scope="col">Line</th>
              <th scope="col" className="numeric">
                Quarter
              </th>
              <th scope="col" className="numeric">
                Year to date
              </th>
            </tr>
          </thead>
          <tbody>
            {form.rows.map((row) => (
              <tr key={row.sno} className={row.isComputed ? 'row--computed' : ''}>
                <td className="numeric">{row.sno}</td>
                <td>{row.label}</td>
                <td className="numeric">{formatMoney(row.quarterAmount)}</td>
                <td className="numeric">{formatMoney(row.yearToDateAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function Msp2_07Table({ form }: { form: Msp2_07 }): ReactNode {
  return (
    <Panel title="MSP2-07 — Deposits and borrowings">
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col" rowSpan={2}>
                Counterparty
              </th>
              <th scope="col" colSpan={3}>
                Deposits
              </th>
              <th scope="col" colSpan={3}>
                Borrowings
              </th>
            </tr>
            <tr>
              <th scope="col" className="numeric">
                TZS
              </th>
              <th scope="col" className="numeric">
                Foreign (TZS eq.)
              </th>
              <th scope="col" className="numeric">
                Total
              </th>
              <th scope="col" className="numeric">
                TZS
              </th>
              <th scope="col" className="numeric">
                Foreign (TZS eq.)
              </th>
              <th scope="col" className="numeric">
                Total
              </th>
            </tr>
          </thead>
          {form.sections.map((section) => (
            <tbody key={section.kind}>
              <tr className="row--section">
                <th scope="rowgroup" colSpan={7}>
                  {SECTION_LABELS[section.kind]}
                </th>
              </tr>
              {section.rows.length === 0 && (
                <tr className="row--muted">
                  <td colSpan={7}>Nothing held in this section.</td>
                </tr>
              )}
              {section.rows.map((row) => (
                <tr key={row.counterparty}>
                  <td>{row.counterparty}</td>
                  <td className="numeric">{formatMoney(row.depositTzs)}</td>
                  <td className="numeric">{formatMoney(row.depositForeignTzsEquivalent)}</td>
                  <td className="numeric">{formatMoney(row.depositTotal)}</td>
                  <td className="numeric">{formatMoney(row.borrowingTzs)}</td>
                  <td className="numeric">{formatMoney(row.borrowingForeignTzsEquivalent)}</td>
                  <td className="numeric">{formatMoney(row.borrowingTotal)}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">Subtotal</th>
                <td className="numeric">{formatMoney(section.subtotal.depositTzs)}</td>
                <td className="numeric">
                  {formatMoney(section.subtotal.depositForeignTzsEquivalent)}
                </td>
                <td className="numeric">{formatMoney(section.subtotal.depositTotal)}</td>
                <td className="numeric">{formatMoney(section.subtotal.borrowingTzs)}</td>
                <td className="numeric">
                  {formatMoney(section.subtotal.borrowingForeignTzsEquivalent)}
                </td>
                <td className="numeric">{formatMoney(section.subtotal.borrowingTotal)}</td>
              </tr>
            </tbody>
          ))}
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="numeric">{formatMoney(form.total.depositTzs)}</td>
              <td className="numeric">{formatMoney(form.total.depositForeignTzsEquivalent)}</td>
              <td className="numeric">{formatMoney(form.total.depositTotal)}</td>
              <td className="numeric">{formatMoney(form.total.borrowingTzs)}</td>
              <td className="numeric">{formatMoney(form.total.borrowingForeignTzsEquivalent)}</td>
              <td className="numeric">{formatMoney(form.total.borrowingTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Panel>
  );
}

/**
 * MSP2-08, shown for the banks actually used.
 *
 * BOT prints all 52 institutions on its agent-banking list. An institution
 * typically works with two or three, and 49 rows of zero help nobody checking a
 * return — the total, which is what rule 15 ties to MSP2-01, is printed
 * regardless.
 */
export function Msp2_08Table({ form }: { form: Msp2_08 }): ReactNode {
  const used = form.rows.filter((row) => row.balance !== '0.00');

  return (
    <Panel title="MSP2-08 — Agent banking balances">
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Bank</th>
              <th scope="col" className="numeric">
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {used.length === 0 && (
              <tr className="row--muted">
                <td colSpan={2}>No agent-banking balance recorded for this quarter.</td>
              </tr>
            )}
            {used.map((row) => (
              <tr key={row.institutionCode}>
                <td>{formatStatus(row.institutionCode)}</td>
                <td className="numeric">{formatMoney(row.balance)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="numeric">{formatMoney(form.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Panel>
  );
}

export function Msp2_03Table({ form }: { form: Msp2_03 }): ReactNode {
  return (
    <Panel title="MSP2-03 — Sectoral classification and provisioning">
      <dl className="totals">
        <div>
          <dt>Non-performing ratio</dt>
          <dd>{formatPercentage(form.nonPerformingRatio)}</dd>
        </div>
      </dl>

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Sector</th>
              <th scope="col" className="numeric">
                Borrowers
              </th>
              <th scope="col" className="numeric">
                Current
              </th>
              <th scope="col" className="numeric">
                ESM
              </th>
              <th scope="col" className="numeric">
                Substandard
              </th>
              <th scope="col" className="numeric">
                Doubtful
              </th>
              <th scope="col" className="numeric">
                Loss
              </th>
              <th scope="col" className="numeric">
                Outstanding
              </th>
              <th scope="col" className="numeric">
                Provision (net)
              </th>
              <th scope="col" className="numeric">
                Written off
              </th>
            </tr>
          </thead>
          <tbody>
            {form.rows.map((row) => (
              <tr key={row.sectorCode} className={row.borrowerCount === 0 ? 'row--muted' : ''}>
                <td>{formatStatus(row.sectorCode)}</td>
                <td className="numeric">{row.borrowerCount}</td>
                <td className="numeric">{formatMoney(row.outstandingByClass.current)}</td>
                <td className="numeric">{formatMoney(row.outstandingByClass.esm)}</td>
                <td className="numeric">{formatMoney(row.outstandingByClass.substandard)}</td>
                <td className="numeric">{formatMoney(row.outstandingByClass.doubtful)}</td>
                <td className="numeric">{formatMoney(row.outstandingByClass.loss)}</td>
                <td className="numeric">{formatMoney(row.totalOutstanding)}</td>
                <td className="numeric">{formatMoney(row.netProvision)}</td>
                <td className="numeric">{formatMoney(row.writtenOffDuringPeriod)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="numeric">{form.total.borrowerCount}</td>
              <td className="numeric">{formatMoney(form.total.outstandingByClass.current)}</td>
              <td className="numeric">{formatMoney(form.total.outstandingByClass.esm)}</td>
              <td className="numeric">{formatMoney(form.total.outstandingByClass.substandard)}</td>
              <td className="numeric">{formatMoney(form.total.outstandingByClass.doubtful)}</td>
              <td className="numeric">{formatMoney(form.total.outstandingByClass.loss)}</td>
              <td className="numeric">{formatMoney(form.total.totalOutstanding)}</td>
              <td className="numeric">{formatMoney(form.total.netProvision)}</td>
              <td className="numeric">{formatMoney(form.total.writtenOffDuringPeriod)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Panel>
  );
}

export function Msp2_04Table({ form }: { form: Msp2_04 }): ReactNode {
  return (
    <Panel title="MSP2-04 — Interest rate structure">
      <p className="hint-block">
        Rates are percent per annum, converted from the monthly rate on each loan using the{' '}
        <strong>{form.annualisation}</strong> convention. Which convention BOT reads is an open
        question (§11.2), so the one applied is stated rather than assumed. The weighted average
        reproduces BOT&rsquo;s own formula, which double-counts — see §5.1 of the reporting
        specification.
      </p>

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col" rowSpan={2}>
                Loan type
              </th>
              <th scope="col" rowSpan={2} className="numeric">
                Borrowers
              </th>
              <th scope="col" rowSpan={2} className="numeric">
                Outstanding
              </th>
              <th scope="col" colSpan={3}>
                Straight line
              </th>
              <th scope="col" colSpan={3}>
                Reducing balance
              </th>
            </tr>
            <tr>
              <th scope="col" className="numeric">
                Low
              </th>
              <th scope="col" className="numeric">
                High
              </th>
              <th scope="col" className="numeric">
                Weighted
              </th>
              <th scope="col" className="numeric">
                Low
              </th>
              <th scope="col" className="numeric">
                High
              </th>
              <th scope="col" className="numeric">
                Weighted
              </th>
            </tr>
          </thead>
          <tbody>
            {form.rows.map((row) => (
              <tr key={row.botLoanType} className={row.borrowerCount === 0 ? 'row--muted' : ''}>
                <td>{formatStatus(row.botLoanType)}</td>
                <td className="numeric">{row.borrowerCount}</td>
                <td className="numeric">{formatMoney(row.totalOutstanding)}</td>
                <td className="numeric">
                  <Rate value={row.straightLine.lowest} />
                </td>
                <td className="numeric">
                  <Rate value={row.straightLine.highest} />
                </td>
                <td className="numeric">
                  <Rate value={row.straightLine.weightedAverage} />
                </td>
                <td className="numeric">
                  <Rate value={row.reducingBalance.lowest} />
                </td>
                <td className="numeric">
                  <Rate value={row.reducingBalance.highest} />
                </td>
                <td className="numeric">
                  <Rate value={row.reducingBalance.weightedAverage} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="numeric">{form.total.borrowerCount}</td>
              <td className="numeric">{formatMoney(form.total.totalOutstanding)}</td>
              <td className="numeric">
                <Rate value={form.total.straightLine.lowest} />
              </td>
              <td className="numeric">
                <Rate value={form.total.straightLine.highest} />
              </td>
              <td className="numeric">
                <Rate value={form.total.straightLine.weightedAverage} />
              </td>
              <td className="numeric">
                <Rate value={form.total.reducingBalance.lowest} />
              </td>
              <td className="numeric">
                <Rate value={form.total.reducingBalance.highest} />
              </td>
              <td className="numeric">
                <Rate value={form.total.reducingBalance.weightedAverage} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Panel>
  );
}

export function Msp2_09Table({ form }: { form: Msp2_09 }): ReactNode {
  return (
    <Panel title="MSP2-09 — Loans disbursed by gender and sector">
      <p className="hint-block">
        A flow, not a balance: what was advanced during the quarter, at the principal advanced
        rather than the amount still owing.
      </p>

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col" rowSpan={2}>
                Sector
              </th>
              <th scope="col" colSpan={2}>
                Female
              </th>
              <th scope="col" colSpan={2}>
                Male
              </th>
              <th scope="col" colSpan={2}>
                Total
              </th>
            </tr>
            <tr>
              <th scope="col" className="numeric">
                Loans
              </th>
              <th scope="col" className="numeric">
                Amount
              </th>
              <th scope="col" className="numeric">
                Loans
              </th>
              <th scope="col" className="numeric">
                Amount
              </th>
              <th scope="col" className="numeric">
                Loans
              </th>
              <th scope="col" className="numeric">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {form.rows.map((row) => (
              <tr key={row.sectorCode} className={row.total.count === 0 ? 'row--muted' : ''}>
                <td>{formatStatus(row.sectorCode)}</td>
                <td className="numeric">{row.female.count}</td>
                <td className="numeric">{formatMoney(row.female.amount)}</td>
                <td className="numeric">{row.male.count}</td>
                <td className="numeric">{formatMoney(row.male.amount)}</td>
                <td className="numeric">{row.total.count}</td>
                <td className="numeric">{formatMoney(row.total.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="numeric">{form.total.female.count}</td>
              <td className="numeric">{formatMoney(form.total.female.amount)}</td>
              <td className="numeric">{form.total.male.count}</td>
              <td className="numeric">{formatMoney(form.total.male.amount)}</td>
              <td className="numeric">{form.total.total.count}</td>
              <td className="numeric">{formatMoney(form.total.total.amount)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Panel>
  );
}

/**
 * MSP2-10, shown by region until asked otherwise.
 *
 * The filed form carries all 193 districts. Printing them here would bury the
 * dozen an institution actually operates in under 180 rows of zeros, so the
 * default view is the 31 region subtotals BOT also prints — and the full list
 * is one control away, because the operator checking a return needs to be able
 * to see what will be submitted.
 */
export function Msp2_10Table({ form }: { form: Msp2_10 }): ReactNode {
  const [showAllDistricts, setShowAllDistricts] = useState(false);

  const districts = showAllDistricts
    ? form.districts
    : form.districts.filter((row) => row.totalBorrowers > 0 || row.branchCount > 0);

  return (
    <Panel
      title="MSP2-10 — Geographic distribution"
      actions={
        <button
          className="button button--small"
          type="button"
          onClick={() => {
            setShowAllDistricts((shown) => !shown);
          }}
        >
          {showAllDistricts
            ? 'Show only districts in use'
            : `Show all ${String(form.districts.length)}`}
        </button>
      }
    >
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">District</th>
              <th scope="col">Region</th>
              <th scope="col" className="numeric">
                Branches
              </th>
              <th scope="col" className="numeric">
                Employees
              </th>
              <th scope="col" className="numeric">
                Up to 35 (F)
              </th>
              <th scope="col" className="numeric">
                Up to 35 (M)
              </th>
              <th scope="col" className="numeric">
                Above 35 (F)
              </th>
              <th scope="col" className="numeric">
                Above 35 (M)
              </th>
              <th scope="col" className="numeric">
                Outstanding
              </th>
            </tr>
          </thead>
          <tbody>
            {districts.map((row) => (
              <tr key={row.districtCode} className={row.totalBorrowers === 0 ? 'row--muted' : ''}>
                <td>{row.districtCode}</td>
                <td>{row.regionCode}</td>
                <td className="numeric">{row.branchCount}</td>
                <td className="numeric">{row.employeeCount}</td>
                <td className="numeric">{row.cells.up_to_35_female.borrowerCount}</td>
                <td className="numeric">{row.cells.up_to_35_male.borrowerCount}</td>
                <td className="numeric">{row.cells.above_35_female.borrowerCount}</td>
                <td className="numeric">{row.cells.above_35_male.borrowerCount}</td>
                <td className="numeric">{formatMoney(row.totalOutstanding)}</td>
              </tr>
            ))}
            {districts.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  No district has a branch or a borrower in this period.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>
                Grand total
              </th>
              <td className="numeric">{form.grandTotal.branchCount}</td>
              <td className="numeric">{form.grandTotal.employeeCount}</td>
              <td className="numeric" colSpan={4}>
                {form.grandTotal.totalBorrowers} borrowers
              </td>
              <td className="numeric">{formatMoney(form.grandTotal.totalOutstanding)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Panel>
  );
}

/** Every form in the compiled return, in BOT's order. */
export function ReturnForms({ compiled }: { compiled: CompiledReturn }): ReactNode {
  return (
    <>
      <Msp2_02Table form={compiled.msp2_02} />
      <Msp2_03Table form={compiled.msp2_03} />
      <Msp2_04Table form={compiled.msp2_04} />
      <Msp2_07Table form={compiled.msp2_07} />
      <Msp2_08Table form={compiled.msp2_08} />
      <Msp2_09Table form={compiled.msp2_09} />
      <Msp2_10Table form={compiled.msp2_10} />
    </>
  );
}
