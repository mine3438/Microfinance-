import { type ReactNode } from 'react';

/**
 * A labelled form control with its error.
 *
 * The error is tied to the input with `aria-describedby` and `aria-invalid`, so
 * a screen reader announces the reason rather than only that something is
 * wrong. Field errors come from the server's `details` array, which names the
 * path — so the message appears beside the box it refers to rather than in a
 * banner at the top of the form.
 */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: (props: {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby'?: string;
  }) => ReactNode;
}): ReactNode {
  const describedBy =
    error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;

  return (
    <div className={`field${error !== undefined ? ' field--invalid' : ''}`}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        'aria-invalid': error !== undefined,
        ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }),
      })}
      {error !== undefined ? (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      ) : (
        hint !== undefined && (
          <p className="field__hint" id={`${id}-hint`}>
            {hint}
          </p>
        )
      )}
    </div>
  );
}
