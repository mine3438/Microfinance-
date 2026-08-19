import { GENDERS } from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { ApiRequestError } from '../../shared/api/client.js';
import { clients as clientsApi, reference } from '../../shared/api/endpoints.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';

/**
 * Registering a borrower.
 *
 * The district and sector are chosen from BOT's own published lists rather than
 * typed. They were typed until `GET /reference/districts` and
 * `/reference/sectors` existed, and the gap was worse than an inconvenience: an
 * unknown code the server refuses is caught, but a *misspelling that happens to
 * be another real district* is not refused at all. It silently moves a borrower
 * from one MSP2-10 district total into another, and no validation anywhere can
 * notice.
 *
 * District names repeat across regions, which is why each option carries its
 * region — a list of 193 bare names cannot be chosen from correctly.
 */
export function NewClientPage(): ReactNode {
  const districts = useQuery({
    queryKey: ['districts'],
    queryFn: () => reference.districts(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const sectors = useQuery({
    queryKey: ['sectors'],
    queryFn: () => reference.sectors(),
    staleTime: Number.POSITIVE_INFINITY,
  });

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
            label="District"
            hint="Where the borrower lives. MSP2-10 reports borrowers per district."
            error={fieldError('districtCode')}
          >
            {(props) => (
              <select
                {...props}
                className="input"
                value={districtCode}
                onChange={(event) => {
                  setDistrictCode(event.target.value);
                }}
                required
              >
                <option value="">Choose a district…</option>
                {(districts.data ?? []).map((district) => (
                  <option key={district.code} value={district.code}>
                    {district.name} — {district.regionName}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field
            id="sector"
            label="Economic sector"
            hint="What the borrower's activity is. MSP2-03 classifies and provisions by sector."
            error={fieldError('sectorCode')}
          >
            {(props) => (
              <select
                {...props}
                className="input"
                value={sectorCode}
                onChange={(event) => {
                  setSectorCode(event.target.value);
                }}
                required
              >
                <option value="">Choose a sector…</option>
                {(sectors.data ?? []).map((sector) => (
                  <option key={sector.code} value={sector.code}>
                    {sector.name}
                  </option>
                ))}
              </select>
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
