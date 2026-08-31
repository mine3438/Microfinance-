import { MINIMUM_PASSWORD_LENGTH } from '@mfi/contracts';
import { useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { ApiRequestError } from '../../shared/api/client.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { useSession } from './session.js';

interface LocationState {
  readonly from?: string;
}

export function SignInPage(): ReactNode {
  const session = useSession();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  if (session.status === 'signed-in') {
    const from = (location.state as LocationState | null)?.from;
    return <Navigate to={from ?? '/clients'} replace />;
  }

  async function onSubmit(event: { preventDefault: () => void }): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await session.signIn(email, password);
    } catch (caught: unknown) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  const fieldError = (field: string): string | undefined =>
    error instanceof ApiRequestError ? error.fieldError(field) : undefined;

  return (
    <main className="sign-in">
      <div className="sign-in__card">
        <h1 className="sign-in__title">MFI Manager</h1>
        <p className="sign-in__subtitle">Sign in to your institution</p>

        {error !== null && <ErrorNotice error={error} />}

        <form
          onSubmit={(event) => {
            void onSubmit(event);
          }}
          noValidate
        >
          <Field id="email" label="Email address" error={fieldError('email')}>
            {(props) => (
              <input
                {...props}
                className="input"
                type="email"
                name="email"
                autoComplete="username"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
                required
              />
            )}
          </Field>

          <Field
            id="password"
            label="Password"
            hint={`At least ${String(MINIMUM_PASSWORD_LENGTH)} characters. A memorable phrase is stronger than a short complex password.`}
            error={fieldError('password')}
          >
            {(props) => (
              <input
                {...props}
                className="input"
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
                required
              />
            )}
          </Field>

          <button
            className="button button--primary button--block"
            type="submit"
            disabled={submitting}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
