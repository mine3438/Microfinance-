import { useEffect, useState } from 'react';

/**
 * A value that settles after typing stops.
 *
 * Used to key a search query, so a borrower's name typed at speed produces one
 * request rather than one per keystroke. Without it, "Amina Hassan" is twelve
 * round trips whose first eleven answers are discarded before they arrive — and
 * on a branch connection the last one is not reliably the last to return.
 *
 * The timer is cleared on every change and on unmount, so a component that goes
 * away mid-type never sets state afterwards.
 */
export function useDebounced<T>(value: T, delayMilliseconds = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delayMilliseconds);

    return (): void => {
      clearTimeout(timer);
    };
  }, [value, delayMilliseconds]);

  return settled;
}
