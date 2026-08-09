import { GENDERS } from '@mfi/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { ApiRequestError } from '../../shared/api/client.js';
import { clients as clientsApi } from '../../shared/api/endpoints.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';

/**
 * Registering a borrower.
 *
 * The district and sector codes are typed rather than chosen from a list, which
 * is a gap this screen has until the reference taxonomies get their own
 * endpoint — BOT publishes 193 districts and 22 sectors, and a text box invites
 * the misspelling that drops a borrower out of an MSP2-10 total. The server
 * refuses an unknown code and names the field, so the mistake is caught; it is
 * still a worse experience than a picker.
 */
export function NewClientPage(): ReactNode {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [fullName, setFullName] = useState('');
  const [gender, setGender] = useState<string>('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [phone, setPhone] = useState('');
  const [districtCode, setDistrictCode] = useState('');
  const [sectorCode, setSectorCode] = useState('');

  const create = useMutation({
    mutationFn: () =>
      clientsApi.create({
        fullName,
        gender: gender as 'male' | 'female',
        dateOfBirth,
        phone,
        districtCode,
        sectorCode,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['clients'] });
      void navigate('/clients');
    },
  });

  const fieldError = (field: string): string | undefined =>
    create.error instanceof ApiRequestError ? create.error.fieldError(field) : undefined;

  function onSubmit(event: { preventDefault: () => void }): void {
    event.preventDefault();
    create.mutate();
  }

  return (
    <div className="page">
      <h1 className="page__title">Register a borrower</h1>

      <Panel>
        {create.error !== null && <ErrorNotice error={create.error} />}

        <form onSubmit={onSubmit} noValidate>
          <Field id="full-name" label="Full name" error={fieldError('fullName')}>
            {(props) => (
              <input
                {...props}
                className="input"
                value={fullName}
                onChange={(event) => {
                  setFullName(event.target.value);
                }}
                required
              />
            )}
          </Field>

          <Field
            id="gender"
            label="Gender"
            hint="Male or female only — the Bank of Tanzania's forms provide exactly two columns."
            error={fieldError('gender')}
          >
            {(props) => (
              <select
                {...props}
                className="input"
                value={gender}
                onChange={(event) => {
                  setGender(event.target.value);
                }}
                required
              >
                <option value="">Choose…</option>
                {GENDERS.map((value) => (
                  <option key={value} value={value}>
                    {value === 'male' ? 'Male' : 'Female'}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field id="dob" label="Date of birth" error={fieldError('dateOfBirth')}>
            {(props) => (
              <input
                {...props}
                className="input"
                type="date"
                value={dateOfBirth}
                onChange={(event) => {
                  setDateOfBirth(event.target.value);
                }}
                required
              />
            )}
          </Field>

          <Field
            id="phone"
            label="Phone number"
            hint="Any usual form — 0712345678 or +255712345678. It is stored in one canonical format."
            error={fieldError('phone')}
          >
            {(props) => (
              <input
                {...props}
                className="input"
                type="tel"
                value={phone}
                onChange={(event) => {
                  setPhone(event.target.value);
                }}
                required
              />
            )}
          </Field>

          <Field
            id="district"
            label="District code"
            hint="From the Bank of Tanzania's published district list."
            error={fieldError('districtCode')}
          >
            {(props) => (
              <input
                {...props}
                className="input"
                value={districtCode}
                onChange={(event) => {
                  setDistrictCode(event.target.value.trim());
                }}
                required
              />
            )}
          </Field>

          <Field
            id="sector"
            label="Economic sector code"
            hint="From the Bank of Tanzania's published sector list."
            error={fieldError('sectorCode')}
          >
            {(props) => (
              <input
                {...props}
                className="input"
                value={sectorCode}
                onChange={(event) => {
                  setSectorCode(event.target.value.trim());
                }}
                required
              />
            )}
          </Field>

          <div className="form-actions">
            <button className="button button--primary" type="submit" disabled={create.isPending}>
              {create.isPending ? 'Registering…' : 'Register borrower'}
            </button>
            <button
              className="button"
              type="button"
              onClick={() => {
                void navigate('/clients');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
