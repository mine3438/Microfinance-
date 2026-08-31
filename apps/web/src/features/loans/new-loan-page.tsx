import { type LoanProduct, type RepaymentSchedule } from '@mfi/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { ApiRequestError } from '../../shared/api/client.js';
import { loans as loansApi } from '../../shared/api/endpoints.js';
import {
  formatDate,
  formatMoney,
  formatMoneyWithCurrency,
  formatMonthlyRate,
} from '../../shared/lib/format.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { ClientPicker } from '../../shared/ui/client-picker.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';

/**
 * A loan application, with the schedule shown as it is entered.
 *
 * **This screen computes nothing.** Every figure in the table below — each
 * instalment, each interest amount, the totals — arrives from
 * `/loans/preview-schedule`, which runs the same generator the disbursement
 * path runs. There is no multiplication of a principal by a rate anywhere in
 * this file, and `@mfi/money` is deliberately not a dependency of this package
 * so that there is nothing here to do it with.
 *
 * That is the whole reason the preview endpoint exists. The system this
 * replaces calculated the schedule in the browser to display it and again on
 * the server to store it, and its own technical document warned that if the two
 * drifted the borrower would be shown one set of instalments and held to
 * another.
 */
export function NewLoanPage(): ReactNode {
  const navigate = useNavigate();

  const [clientId, setClientId] = useState('');
  const [productId, setProductId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [monthlyRate, setMonthlyRate] = useState('');
  const [termMonths, setTermMonths] = useState('');

  const productList = useQuery({ queryKey: ['loan-products'], queryFn: () => loansApi.products() });

  const selectedProduct: LoanProduct | undefined = useMemo(
    () => productList.data?.find((product) => product.id === productId),
    [productList.data, productId],
  );

  // Filling the rate from the product's floor is a convenience, not a
  // calculation: it puts a permitted value in the box rather than leaving an
  // officer to guess what the product allows.
  useEffect(() => {
    if (selectedProduct !== undefined && monthlyRate === '') {
      setMonthlyRate(selectedProduct.minMonthlyRate);
    }
  }, [selectedProduct, monthlyRate]);

  const complete =
    clientId !== '' &&
    productId !== '' &&
    principal !== '' &&
    monthlyRate !== '' &&
    termMonths !== '';

  /**
   * The preview.
   *
   * Keyed on the terms, so React Query caches per set of inputs and an officer
   * moving back and forth between two figures does not re-ask. Refused terms
   * are not retried: a principal outside the product's range will be refused
   * again, and retrying turns one clear message into three.
   */
  const preview = useQuery({
    queryKey: ['schedule-preview', clientId, productId, principal, monthlyRate, termMonths],
    queryFn: () =>
      loansApi.previewSchedule({
        clientId,
        productId,
        principal,
        monthlyRate,
        termMonths: Number(termMonths),
      }),
    enabled: complete,
    retry: false,
  });

  const create = useMutation({
    mutationFn: () =>
      loansApi.create({
        clientId,
        productId,
        principal,
        monthlyRate,
        termMonths: Number(termMonths),
      }),
    onSuccess: (loan) => {
      void navigate(`/loans/${loan.id}`);
    },
  });

  const fieldError = (field: string): string | undefined => {
    for (const source of [create.error, preview.error]) {
      if (source instanceof ApiRequestError) {
        const message = source.fieldError(field);
        if (message !== undefined) {
          return message;
        }
      }
    }
    return undefined;
  };

  return (
    <div className="page">
      <h1 className="page__title">New loan application</h1>

      <div className="layout layout--split">
        <Panel title="Terms">
          {create.error !== null && <ErrorNotice error={create.error} />}

          <ClientPicker
            id="client"
            label="Borrower"
            value={clientId}
            onChange={setClientId}
            error={fieldError('clientId')}
          />

          <Field id="product" label="Product" error={fieldError('productId')}>
            {(props) => (
              <select
                {...props}
                className="input"
                value={productId}
                onChange={(event) => {
                  setProductId(event.target.value);
                  setMonthlyRate('');
                }}
              >
                <option value="">Choose a product…</option>
                {productList.data
                  ?.filter((product) => product.status === 'active')
                  .map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}
                    </option>
                  ))}
              </select>
            )}
          </Field>

          {selectedProduct !== undefined && (
            <p className="hint-block">
              {selectedProduct.interestMethod === 'flat' ? 'Flat interest' : 'Reducing balance'}.
              Between {formatMoneyWithCurrency(selectedProduct.minPrincipal)} and{' '}
              {formatMoneyWithCurrency(selectedProduct.maxPrincipal)}, over{' '}
              {selectedProduct.minTermMonths}–{selectedProduct.maxTermMonths} months, at{' '}
              {formatMonthlyRate(selectedProduct.minMonthlyRate)} to{' '}
              {formatMonthlyRate(selectedProduct.maxMonthlyRate)}.
            </p>
          )}

          <Field
            id="principal"
            label="Principal (TZS)"
            hint="Enter the amount in shillings, for example 1200000 or 1200000.50."
            error={fieldError('principal')}
          >
            {(props) => (
              <input
                {...props}
                className="input"
                // `inputMode` rather than `type="number"`: a number input hands
                // back a JS number, and the API refuses amounts that arrived as
                // doubles. The value is carried as the string the user typed.
                inputMode="decimal"
                value={principal}
                onChange={(event) => {
                  setPrincipal(event.target.value.trim());
                }}
              />
            )}
          </Field>

          <Field
            id="rate"
            label="Monthly rate"
            hint="As a fraction: 0.03 is three percent a month."
            error={fieldError('monthlyRate')}
          >
            {(props) => (
              <input
                {...props}
                className="input"
                inputMode="decimal"
                value={monthlyRate}
                onChange={(event) => {
                  setMonthlyRate(event.target.value.trim());
                }}
              />
            )}
          </Field>

          <Field id="term" label="Term (months)" error={fieldError('termMonths')}>
            {(props) => (
              <input
                {...props}
                className="input"
                inputMode="numeric"
                value={termMonths}
                onChange={(event) => {
                  setTermMonths(event.target.value.trim());
                }}
              />
            )}
          </Field>

          <button
            className="button button--primary"
            type="button"
            disabled={!complete || preview.data === undefined || create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            {create.isPending ? 'Saving…' : 'Save as draft'}
          </button>

          <p className="hint-block">
            Saved as a draft. It is submitted for approval separately, and approved by someone other
            than whoever submitted it.
          </p>
        </Panel>

        <SchedulePreview
          complete={complete}
          loading={preview.isFetching}
          error={preview.error}
          schedule={preview.data}
        />
      </div>
    </div>
  );
}

function SchedulePreview({
  complete,
  loading,
  error,
  schedule,
}: {
  complete: boolean;
  loading: boolean;
  error: unknown;
  schedule: RepaymentSchedule | undefined;
}): ReactNode {
  if (!complete) {
    return (
      <Panel title="Repayment schedule">
        <p className="muted">Fill in the terms and the schedule will appear here.</p>
      </Panel>
    );
  }

  if (loading && schedule === undefined) {
    return (
      <Panel title="Repayment schedule">
        <Spinner label="Working out the schedule" />
      </Panel>
    );
  }

  if (error !== null && schedule === undefined) {
    return (
      <Panel title="Repayment schedule" tone="warning">
        <ErrorNotice error={error} />
      </Panel>
    );
  }

  if (schedule === undefined) {
    return null;
  }

  return (
    <Panel title="Repayment schedule">
      <dl className="totals">
        <div>
          <dt>Principal</dt>
          <dd>{formatMoneyWithCurrency(schedule.totalPrincipal)}</dd>
        </div>
        <div>
          <dt>Interest</dt>
          <dd>{formatMoneyWithCurrency(schedule.totalInterest)}</dd>
        </div>
        <div className="totals__emphasis">
          <dt>Total repayable</dt>
          <dd>{formatMoneyWithCurrency(schedule.totalRepayable)}</dd>
        </div>
      </dl>

      <div className="table-scroll">
        <table className="table">
          <caption className="visually-hidden">Instalments, with the amount due each month</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Due</th>
              <th scope="col" className="numeric">
                Principal
              </th>
              <th scope="col" className="numeric">
                Interest
              </th>
              <th scope="col" className="numeric">
                Total
              </th>
              <th scope="col" className="numeric">
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {schedule.instalments.map((instalment) => (
              <tr key={instalment.monthNumber}>
                <td>{instalment.monthNumber}</td>
                <td>{formatDate(instalment.dueDate)}</td>
                <td className="numeric">{formatMoney(instalment.principalDue)}</td>
                <td className="numeric">{formatMoney(instalment.interestDue)}</td>
                <td className="numeric">{formatMoney(instalment.totalDue)}</td>
                <td className="numeric">{formatMoney(instalment.closingBalance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="hint-block">
        Every figure here was calculated by the server, by the same code that will write the
        schedule when the loan is disbursed.
      </p>
    </Panel>
  );
}
