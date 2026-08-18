import { type Client } from '@mfi/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { clients as clientsApi } from '../api/endpoints.js';
import { useDebounced } from '../lib/use-debounced.js';
import { Field } from './field.js';

/**
 * Choosing a borrower, at any size of book.
 *
 * The screens that needed a borrower each loaded the first hundred active
 * clients into a `<select>`. For an institution with more than a hundred, the
 * hundred-and-first borrower could not be chosen at all — no loan, no savings
 * account — and the loan screen did not say so. That is not a scaling nicety:
 * it is a borrower the system refuses to serve, silently.
 *
 * So the list is searched rather than enumerated. The search runs on the server
 * (`GET /clients?search=`, which matches name or client code), the term is
 * debounced so typing produces one request rather than one per keystroke, and
 * the result count is capped small deliberately — a picker that returns
 * twenty-five names is one a teller can read, where two hundred is a list they
 * scroll past.
 *
 * Two controls rather than a combobox, and that is deliberate too. A native
 * text input and a native `<select>` are keyboard-operable and announced
 * correctly by every screen reader without a single `aria-activedescendant`;
 * a hand-rolled combobox is where accessibility quietly breaks.
 */

/** Enough to choose from, few enough to read. */
const MATCH_LIMIT = 25;

export function ClientPicker({
  id,
  label,
  value,
  onChange,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (clientId: string) => void;
  error?: string | undefined;
}): ReactNode {
  const [term, setTerm] = useState('');
  const settledTerm = useDebounced(term.trim());

  const matches = useQuery({
    queryKey: ['clients', 'picker', settledTerm],
    queryFn: () =>
      clientsApi.list({
        status: 'active',
        limit: MATCH_LIMIT,
        ...(settledTerm === '' ? {} : { search: settledTerm }),
      }),
  });

  const items = matches.data?.items ?? [];
  const truncated = matches.data?.nextCursor !== null && matches.data !== undefined;

  return (
    <>
      <Field
        id={`${id}-search`}
        label={`Search ${label.toLowerCase()}`}
        hint="By name or client code. Leave blank to list the most recent."
      >
        {(props) => (
          <input
            {...props}
            className="input"
            type="search"
            value={term}
            onChange={(event) => {
              setTerm(event.target.value);
            }}
          />
        )}
      </Field>

      <Field
        id={id}
        label={label}
        hint={
          truncated
            ? `More than ${String(MATCH_LIMIT)} match. Narrow the search to see the rest.`
            : undefined
        }
        error={error}
      >
        {(props) => (
          <select
            {...props}
            className="input"
            value={value}
            required
            onChange={(event) => {
              onChange(event.target.value);
            }}
          >
            <option value="">
              {matches.isPending ? 'Searching…' : items.length === 0 ? 'No matches' : 'Choose one…'}
            </option>
            {items.map((client: Client) => (
              <option key={client.id} value={client.id}>
                {client.fullName} — {client.clientCode}
              </option>
            ))}
          </select>
        )}
      </Field>
    </>
  );
}
