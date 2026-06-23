import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import InstalmentHero from './InstalmentHero';

// ─── Display tests — the hero must tell the truth about ladder state ───
//
// The dashboard previously filtered failed/defaulted rows out entirely,
// so a patient who got a "we'll retry on 1 July" email would see the
// hero either skip the failed row or say "all paid up". These tests
// pin the post-fix behaviour: failed rows show the next-attempt date
// and outstanding (instalment + fees); defaulted rows show "in default";
// scheduled rows show the normal upcoming copy.

function baseRow(overrides: Partial<Parameters<typeof InstalmentHero>[0]['instalments'][number]> = {}) {
  return {
    practiceName:     'Test Practice',
    instalmentNumber: 2,
    planType:         3,
    amount:           250,
    dunningFeesCents: 0,
    status:           'scheduled',
    ...overrides,
  };
}

describe('InstalmentHero — scheduled (healthy upcoming)', () => {
  it('renders "Next Instalment" label and the bare due date', () => {
    render(
      <InstalmentHero
        dueDate="2026-07-01"
        total={250}
        isOverdue={false}
        isToday={false}
        groupState="scheduled"
        instalments={[baseRow()]}
      />,
    );
    expect(screen.getByText(/Next Instalment/i)).toBeInTheDocument();
    expect(screen.getByText(/Due 1 Jul 2026/)).toBeInTheDocument();
    expect(screen.getByText('R250.00')).toBeInTheDocument();
  });
});

describe('InstalmentHero — failed (in ladder)', () => {
  it('shows "Payment Failed" label and the next_attempt_date as the retry line', () => {
    render(
      <InstalmentHero
        dueDate="2026-07-01"
        total={350}       // 250 instalment + R100 fee
        isOverdue={false}
        isToday={false}
        groupState="failed"
        instalments={[baseRow({ status: 'failed', dunningFeesCents: 10_000 })]}
      />,
    );
    expect(screen.getByText(/Payment Failed/i)).toBeInTheDocument();
    expect(screen.getByText(/We'll retry on 1 Jul 2026/)).toBeInTheDocument();
    // Outstanding includes the fee — not the bare instalment.
    expect(screen.getByText('R350.00')).toBeInTheDocument();
  });
});

describe('InstalmentHero — defaulted (cap reached)', () => {
  it('shows "In Default" label and the settle-prompt copy', () => {
    render(
      <InstalmentHero
        dueDate="2026-07-15"
        total={550}       // 250 instalment + R300 cap
        isOverdue={true}
        isToday={false}
        groupState="defaulted"
        instalments={[baseRow({ status: 'defaulted', dunningFeesCents: 30_000 })]}
      />,
    );
    expect(screen.getByText(/In Default — Please Settle/i)).toBeInTheDocument();
    expect(screen.getByText(/No further retries/i)).toBeInTheDocument();
    expect(screen.getByText('R550.00')).toBeInTheDocument();
  });
});
