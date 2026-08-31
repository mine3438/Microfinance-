import { type ReactNode } from 'react';

import { ApiRequestError, NetworkError } from '../api/client.js';

/**
 * A failure, shown the way the user needs it.
 *
 * The correlation ID is displayed for an internal error and only then. On a
 * validation failure or a permission refusal the message is already actionable
 * and a reference number is noise; on a 500 the message is deliberately empty
 * of detail, and the reference is the only thing that lets support find the
 * request.
 */
export function ErrorNotice({ error }: { error: unknown }): ReactNode {
  if (error instanceof ApiRequestError) {
    const showReference = error.status >= 500 && error.correlationId !== undefined;

    return (
      <div className="notice notice--danger" role="alert">
        <p className="notice__message">{error.message}</p>
        {showReference && <p className="notice__reference">Reference: {error.correlationId}</p>}
      </div>
    );
  }

  if (error instanceof NetworkError) {
    return (
      <div className="notice notice--danger" role="alert">
        <p className="notice__message">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="notice notice--danger" role="alert">
      <p className="notice__message">Something went wrong. Try again.</p>
    </div>
  );
}
