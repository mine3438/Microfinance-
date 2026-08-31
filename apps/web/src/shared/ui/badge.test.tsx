import { LOAN_STATUSES } from '@mfi/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusBadge } from './badge.js';

/**
 * The status badge's tone table.
 *
 * `TONES` falls back to `neutral` for a status it does not list, so a status
 * added to the contract and forgotten here does not fail anything — it just
 * renders in the default colour. That is fine for `inactive` and wrong for a
 * status whose whole reason for existing is to be told apart from another one.
 */

function toneOf(status: string): string {
  const { container } = render(<StatusBadge status={status} />);
  const badge = container.querySelector('.badge');
  const tone = [...(badge?.classList ?? [])].find((name) => name.startsWith('badge--'));
  if (tone === undefined) {
    throw new Error(`No tone class rendered for status "${status}".`);
  }
  return tone;
}

describe('StatusBadge', () => {
  it('renders a readable label for every loan status the contract defines', () => {
    // A status the badge has never heard of still has to read as words rather
    // than as a raw database value.
    for (const status of LOAN_STATUSES) {
      render(<StatusBadge status={status} />);
    }

    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    expect(screen.getByText('Written off')).toBeInTheDocument();
    expect(screen.getByText('Restructured')).toBeInTheDocument();
  });

  it('does not show a restructured loan the same way as a repaid one', () => {
    // `completed` means the borrower repaid. `restructured` means the debt
    // moved to a successor and nobody repaid anything. They are separate
    // statuses precisely so the two are not confused, and rendering them
    // identically would undo that on the one screen a person actually reads.
    expect(toneOf('restructured')).not.toBe(toneOf('completed'));
  });

  it('shows a written-off loan differently again', () => {
    // Written off is a loss; restructured is not. Three distinct terminal
    // outcomes, three distinct tones.
    expect(toneOf('written_off')).not.toBe(toneOf('restructured'));
    expect(toneOf('written_off')).not.toBe(toneOf('completed'));
  });
});
