import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import DeclinedPlanDetail from './DeclinedPlanDetail';

// ─── Declined-bill copy — merchant name spacing ─────────────────────────
//
// The merchant name is interpolated into two sentences ("…bill from {name}
// wasn't yours…" and "…ask {name} to send it again…"). It must always
// render with a clean single space around it — never glued to the next word
// ("Physiosto send") or doubled — even when the DB value is whitespace-dirty.
// Renders the real component (not a source pin) so the actual output is
// verified.

function renderText(practiceName: string): string {
  const { container } = render(
    <DeclinedPlanDetail
      practiceName={practiceName}
      amount={1200}
      invoiceNumber={null}
      practiceReference={null}
    />,
  );
  return container.textContent ?? '';
}

describe('DeclinedPlanDetail — merchant name is cleanly spaced', () => {
  it('renders both sentences with a single space around the name', () => {
    const text = renderText('Weinberg Physios');
    expect(text).toContain('this bill from Weinberg Physios wasn');       // space before "wasn't"
    expect(text).toContain('ask Weinberg Physios to send it again');       // space before "to"
    // Never glued.
    expect(text).not.toContain('Physioswasn');
    expect(text).not.toContain('Physiosto');
  });

  it('adversarial: a whitespace-dirty name (leading/trailing/double space) renders cleanly', () => {
    const text = renderText('  Weinberg   Physios  ');
    expect(text).toContain('this bill from Weinberg Physios wasn');
    expect(text).toContain('ask Weinberg Physios to send it again');
    // No double space anywhere around the name, no glue, no stray padding.
    expect(text).not.toMatch(/Physios {2,}(wasn|to)/);
    expect(text).not.toContain('Physioswasn');
    expect(text).not.toContain('Physiosto');
    expect(text).not.toContain('from  Weinberg');
  });

  it('adversarial: a name ending in punctuation keeps a single trailing space', () => {
    const text = renderText('Dr. Ncube Inc.');
    expect(text).toContain('this bill from Dr. Ncube Inc. wasn');
    expect(text).toContain('ask Dr. Ncube Inc. to send it again');
    expect(text).not.toMatch(/Inc\. {2,}(wasn|to)/);
  });
});
