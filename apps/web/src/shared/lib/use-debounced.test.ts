import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebounced } from './use-debounced.js';

/**
 * The debounce behind the borrower search.
 *
 * What it has to guarantee is that a name typed at speed produces one value to
 * query on, not one per keystroke — twelve round trips whose first eleven
 * answers are discarded, and on a branch connection the last sent is not
 * reliably the last to return.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebounced', () => {
  it('returns the first value immediately, so nothing renders empty', () => {
    const { result } = renderHook(() => useDebounced('Amina'));

    expect(result.current).toBe('Amina');
  });

  it('holds the previous value until the delay elapses', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounced(value), {
      initialProps: { value: 'A' },
    });

    rerender({ value: 'Am' });
    expect(result.current).toBe('A');

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe('A');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('Am');
  });

  it('settles once on the last value when a whole name is typed at speed', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounced(value), {
      initialProps: { value: '' },
    });

    // Each keystroke restarts the timer, so none of the intermediate terms is
    // ever returned to be queried on.
    for (const term of ['A', 'Am', 'Ami', 'Amin', 'Amina']) {
      rerender({ value: term });
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(result.current).toBe('');
    }

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current).toBe('Amina');
  });

  it('honours a delay it is given', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 1000), {
      initialProps: { value: 'first' },
    });

    rerender({ value: 'second' });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe('first');

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe('second');
  });

  it('clears its timer on unmount, so a component that goes away sets no state', () => {
    const { rerender, unmount } = renderHook(({ value }) => useDebounced(value), {
      initialProps: { value: 'first' },
    });

    rerender({ value: 'second' });
    unmount();

    // A pending timer that survived would fire here and warn about setting
    // state on an unmounted component.
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});
