import {
  INTEREST_METHODS,
  type ApprovalThreshold,
  type BotLoanType,
  type CreateLoanProductRequest,
  type InterestMethod,
  type LoanProduct,
} from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiRequestError } from '../../shared/api/client.js';
import {
  loans as loansApi,
  reference,
  settings as settingsApi,
} from '../../shared/api/endpoints.js';
import { formatMoney } from '../../shared/lib/format.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { Field } from '../../shared/ui/field.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';

/**
 * Where an institution states its own figures.
 *
 * Two things live here, and they are the two the documentation left to the
 * institution rather than to this system: how much each role may sanction
 * (§13.3) and what each loan product's terms are, including the penalty figures
 * §13.1 settled the shape of and left the values of open.
 *
 * Nothing on this screen has a default. An approval limit that has never been
 * set is shown as "no authority", not as a suggestion, and no penalty rate is
 * pre-filled. A figure a borrower is charged should have been typed by somebody
 * who meant it.
 *
 * No arithmetic happens here either. Amounts are strings from the field to the
 * wire, and every bound the form implies is checked again by the server and by
 * a database constraint beneath it.
 */
export function SettingsPage(): ReactNode {
  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Settings</h1>
          <p className="page__subtitle">
            Approval authority and lending products — the institution&rsquo;s own figures.
          </p>
        </div>
      </div>

      <ApprovalThresholdsPanel />
      <LoanProductsPanel />
    </div>
  );
}

/** How much each role may sanction. */
function ApprovalThresholdsPanel(): ReactNode {
  const thresholds = useQuery({
    queryKey: ['approval-thresholds'],
    queryFn: () => settingsApi.approvalThresholds(),
  });

  return (
    <Panel title="Approval limits">
      <p className="muted">
        A role with no limit may sanction nothing. Clearing a limit removes the authority rather
        than making it unlimited.
      </p>

      {thresholds.isPending && <Spinner label="Loading approval limits" />}
      {thresholds.error !== null && <ErrorNotice error={thresholds.error} />}

      {thresholds.data !== undefined && (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col" className="numeric">
                  May sanction up to
                </th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {thresholds.data.map((threshold) => (
                <ThresholdRow key={threshold.roleCode} threshold={threshold} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** One role's limit, set or cleared in place. */
function ThresholdRow({ threshold }: { threshold: ApprovalThreshold }): ReactNode {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');

  const save = useMutation({
    mutationFn: (maxPrincipal: string | null) =>
      settingsApi.setApprovalThreshold(threshold.roleCode, maxPrincipal),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['approval-thresholds'] });
    },
  });

  return (
    <>
      <tr>
        <td>{threshold.roleName}</td>
        <td className="numeric">
          {threshold.maxPrincipal === null ? (
            <span className="muted">No authority</span>
          ) : (
            formatMoney(threshold.maxPrincipal)
          )}
        </td>
        <td>
          <button
            className="button button--small"
            type="button"
            onClick={() => {
              setAmount(threshold.maxPrincipal ?? '');
              setEditing((open) => !open);
            }}
          >
            {editing ? 'Cancel' : threshold.maxPrincipal === null ? 'Set' : 'Change'}
          </button>
        </td>
      </tr>

      {editing && (
        <tr>
          <td colSpan={3}>
            <form
              className="report-controls"
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate(amount);
              }}
            >
              <label className="field" htmlFor={`threshold-${threshold.roleCode}`}>
                <span className="field__label">Maximum principal</span>
                <input
                  id={`threshold-${threshold.roleCode}`}
                  className="input"
                  inputMode="decimal"
                  value={amount}
                  required
                  onChange={(event) => {
                    setAmount(event.target.value);
                  }}
                />
              </label>

              <div className="report-controls__action">
                <button className="button button--primary" type="submit" disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save'}
                </button>
                {threshold.maxPrincipal !== null && (
                  <button
                    className="button button--small"
                    type="button"
                    disabled={save.isPending}
                    onClick={() => {
                      save.mutate(null);
                    }}
                  >
                    Remove authority
                  </button>
                )}
              </div>
            </form>

            {save.error !== null && <ErrorNotice error={save.error} />}
          </td>
        </tr>
      )}
    </>
  );
}

/** The products the institution lends on. */
function LoanProductsPanel(): ReactNode {
  const queryClient = useQueryClient();

  const products = useQuery({ queryKey: ['loan-products'], queryFn: () => loansApi.products() });
  const loanTypes = useQuery({
    queryKey: ['bot-loan-types'],
    queryFn: () => reference.loanTypes(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const [defining, setDefining] = useState(false);

  return (
    <Panel
      title="Loan products"
      actions={
        <button
          className="button button--small"
          type="button"
          onClick={() => {
            setDefining((open) => !open);
          }}
        >
          {defining ? 'Cancel' : 'Define a product'}
        </button>
      }
    >
      {defining && (
        <ProductForm
          loanTypes={loanTypes.data ?? []}
          onCreated={async () => {
            setDefining(false);
            await queryClient.invalidateQueries({ queryKey: ['loan-products'] });
          }}
        />
      )}

      {(products.isPending || loanTypes.isPending) && <Spinner label="Loading products" />}
      {products.error !== null && <ErrorNotice error={products.error} />}
      {loanTypes.error !== null && <ErrorNotice error={loanTypes.error} />}

      {products.data !== undefined &&
        (products.data.length === 0 ? (
          <EmptyState title="No products yet">
            A loan is created from a product and must fall within its bounds, so nothing can be lent
            until one is defined.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">BOT loan type</th>
                  <th scope="col">Method</th>
                  <th scope="col" className="numeric">
                    Principal
                  </th>
                  <th scope="col" className="numeric">
                    Term
                  </th>
                  <th scope="col">Penalty</th>
                </tr>
              </thead>
              <tbody>
                {products.data.map((product) => (
                  <ProductRow key={product.id} product={product} loanTypes={loanTypes.data ?? []} />
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </Panel>
  );
}

function ProductRow({
  product,
  loanTypes,
}: {
  product: LoanProduct;
  loanTypes: readonly BotLoanType[];
}): ReactNode {
  const loanType = loanTypes.find((type) => type.code === product.botLoanType);

  return (
    <tr>
      <td>
        {product.name}
        <span className="muted"> · {product.code}</span>
      </td>
      <td>{loanType?.name ?? product.botLoanType}</td>
      <td>{product.interestMethod === 'flat' ? 'Flat' : 'Reducing balance'}</td>
      <td className="numeric">
        {formatMoney(product.minPrincipal)} – {formatMoney(product.maxPrincipal)}
      </td>
      <td className="numeric">
        {product.minTermMonths}–{product.maxTermMonths} months
      </td>
      <td>{describePenalty(product)}</td>
    </tr>
  );
}

/**
 * A product's penalty terms in words.
 *
 * "None" is stated rather than left blank, because a blank cell reads as
 * "not loaded" where this is a deliberate setting.
 */
function describePenalty(product: LoanProduct): string {
  if (product.penaltyDailyRate === null || product.penaltyGraceDays === null) {
    return 'None';
  }

  const cap =
    product.penaltyCapFraction === null
      ? 'uncapped'
      : `capped at ${product.penaltyCapFraction} of principal`;

  return `${product.penaltyDailyRate}/day after ${String(product.penaltyGraceDays)} days, ${cap}`;
}

/**
 * Defining a product.
 *
 * The penalty fields are one group, sent whole or not at all — the server
 * refuses a rate without a grace period, and the database refuses it again.
 * Leaving the group empty is a real answer: the product charges no penalty.
 */
function ProductForm({
  loanTypes,
  onCreated,
}: {
  loanTypes: readonly BotLoanType[];
  onCreated: () => Promise<void>;
}): ReactNode {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [botLoanType, setBotLoanType] = useState('');
  const [interestMethod, setInterestMethod] = useState<InterestMethod>('reducing_balance');
  const [minMonthlyRate, setMinMonthlyRate] = useState('');
  const [maxMonthlyRate, setMaxMonthlyRate] = useState('');
  const [minTermMonths, setMinTermMonths] = useState('1');
  const [maxTermMonths, setMaxTermMonths] = useState('12');
  const [minPrincipal, setMinPrincipal] = useState('');
  const [maxPrincipal, setMaxPrincipal] = useState('');
  const [charging, setCharging] = useState(false);
  const [penaltyDailyRate, setPenaltyDailyRate] = useState('');
  const [penaltyGraceDays, setPenaltyGraceDays] = useState('');
  const [penaltyCapFraction, setPenaltyCapFraction] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const request: CreateLoanProductRequest = {
        code,
        name,
        botLoanType,
        interestMethod,
        minMonthlyRate,
        maxMonthlyRate,
        minTermMonths: Number(minTermMonths),
        maxTermMonths: Number(maxTermMonths),
        minPrincipal,
        maxPrincipal,
        // Omitted entirely when the product charges nothing, rather than sent
        // as empty strings the server would have to interpret.
        ...(charging
          ? {
              penaltyDailyRate,
              penaltyGraceDays: Number(penaltyGraceDays),
              ...(penaltyCapFraction === '' ? {} : { penaltyCapFraction }),
            }
          : {}),
      };
      return loansApi.createProduct(request);
    },
    onSuccess: onCreated,
  });

  const fieldError = (field: string): string | undefined =>
    create.error instanceof ApiRequestError ? create.error.fieldError(field) : undefined;

  return (
    <>
      <form
        className="product-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <Field id="product-code" label="Code" error={fieldError('code')}>
          {(props) => (
            <input
              {...props}
              className="input"
              value={code}
              maxLength={40}
              required
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
          )}
        </Field>

        <Field id="product-name" label="Name" error={fieldError('name')}>
          {(props) => (
            <input
              {...props}
              className="input"
              value={name}
              maxLength={120}
              required
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          id="product-bot-loan-type"
          label="BOT loan type"
          hint="Decides which MSP2-04 row these loans report on, and which provisioning schedule they classify against."
          error={fieldError('botLoanType')}
        >
          {(props) => (
            <select
              {...props}
              className="input"
              value={botLoanType}
              required
              onChange={(event) => {
                setBotLoanType(event.target.value);
              }}
            >
              <option value="">Choose from BOT&rsquo;s list…</option>
              {loanTypes.map((type) => (
                <option key={type.code} value={type.code}>
                  {type.parentCode === null ? type.name : `— ${type.name}`}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field id="product-interest-method" label="Interest method">
          {(props) => (
            <select
              {...props}
              className="input"
              value={interestMethod}
              onChange={(event) => {
                setInterestMethod(event.target.value as InterestMethod);
              }}
            >
              {INTEREST_METHODS.map((method) => (
                <option key={method} value={method}>
                  {method === 'flat' ? 'Flat' : 'Reducing balance'}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          id="product-min-rate"
          label="Lowest monthly rate"
          hint="A fraction: 0.03 is three percent a month."
          error={fieldError('minMonthlyRate')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              inputMode="decimal"
              value={minMonthlyRate}
              required
              onChange={(event) => {
                setMinMonthlyRate(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          id="product-max-rate"
          label="Highest monthly rate"
          error={fieldError('maxMonthlyRate')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              inputMode="decimal"
              value={maxMonthlyRate}
              required
              onChange={(event) => {
                setMaxMonthlyRate(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          id="product-min-principal"
          label="Smallest principal"
          error={fieldError('minPrincipal')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              inputMode="decimal"
              value={minPrincipal}
              required
              onChange={(event) => {
                setMinPrincipal(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          id="product-max-principal"
          label="Largest principal"
          error={fieldError('maxPrincipal')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              inputMode="decimal"
              value={maxPrincipal}
              required
              onChange={(event) => {
                setMaxPrincipal(event.target.value);
              }}
            />
          )}
        </Field>

        <Field id="product-min-term" label="Shortest term (months)">
          {(props) => (
            <input
              {...props}
              className="input"
              type="number"
              min={1}
              max={360}
              value={minTermMonths}
              required
              onChange={(event) => {
                setMinTermMonths(event.target.value);
              }}
            />
          )}
        </Field>

        <Field id="product-max-term" label="Longest term (months)">
          {(props) => (
            <input
              {...props}
              className="input"
              type="number"
              min={1}
              max={360}
              value={maxTermMonths}
              required
              onChange={(event) => {
                setMaxTermMonths(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          id="product-charges-penalty"
          label="This product charges a late-payment penalty"
          hint="Leave this clear and the product charges none. There is no default rate — the figures below are the institution's to state."
        >
          {(props) => (
            <input
              {...props}
              type="checkbox"
              checked={charging}
              onChange={(event) => {
                setCharging(event.target.checked);
              }}
            />
          )}
        </Field>

        {charging && (
          <>
            <Field
              id="product-penalty-rate"
              label="Daily penalty rate"
              hint="A fraction of the overdue instalment, per day. 0.001 is 0.1% a day, accrued simply and not compounded."
              error={fieldError('penaltyDailyRate')}
            >
              {(props) => (
                <input
                  {...props}
                  className="input"
                  inputMode="decimal"
                  value={penaltyDailyRate}
                  required
                  onChange={(event) => {
                    setPenaltyDailyRate(event.target.value);
                  }}
                />
              )}
            </Field>

            <Field
              id="product-penalty-grace"
              label="Grace days"
              hint="Days after an instalment falls due before penalty begins. Zero charges from the first day late."
              error={fieldError('penaltyGraceDays')}
            >
              {(props) => (
                <input
                  {...props}
                  className="input"
                  type="number"
                  min={0}
                  value={penaltyGraceDays}
                  required
                  onChange={(event) => {
                    setPenaltyGraceDays(event.target.value);
                  }}
                />
              )}
            </Field>

            <Field
              id="product-penalty-cap"
              label="Cap (optional)"
              hint="A fraction of principal at which penalty stops accruing. Leave blank for uncapped."
              error={fieldError('penaltyCapFraction')}
            >
              {(props) => (
                <input
                  {...props}
                  className="input"
                  inputMode="decimal"
                  value={penaltyCapFraction}
                  onChange={(event) => {
                    setPenaltyCapFraction(event.target.value);
                  }}
                />
              )}
            </Field>
          </>
        )}

        <div className="form-actions">
          <button className="button button--primary" type="submit" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create product'}
          </button>
        </div>
      </form>

      {create.error !== null && <ErrorNotice error={create.error} />}
    </>
  );
}
