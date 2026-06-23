import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PlanSettleAffordance from './PlanSettleAffordance';

// ─── Tests — conditional affordance keyed on outstanding count ──────────
//
// 1 outstanding instalment → ONLY "Pay now" renders; "Settle entire
//                            bill" is NOT in the DOM (both would be
//                            the same action for the same amount).
// 2+ outstanding           → expandable choice; tapping the toggle
//                            reveals "Pay next instalment · R<next>"
//                            AND "Settle entire bill · R<sum>" with
//                            distinct amounts so the choice is
//                            meaningful.

const noop = vi.fn().mockResolvedValue({ ok: false, status: 'unauthorized' as const });

function setup(outstandingCount: number, nextCents: number, totalCents: number) {
  return render(
    <PlanSettleAffordance
      planId="plan-1"
      outstandingCount={outstandingCount}
      outstandingTotalCents={totalCents}
      nextOutstanding={{
        paymentId:         'pay-next',
        chargeAmountCents: nextCents,
        instalmentNumber:  3,
      }}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      settleInstalment={noop as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      settleEntirePlan={noop as any}
    />,
  );
}

describe('PlanSettleAffordance — 1 outstanding instalment', () => {
  it('renders ONLY "Pay now · R…" and does NOT render "Settle entire bill"', () => {
    setup(1, 94_500, 94_500);  // single instalment, R945.00
    expect(screen.getByRole('button', { name: /^Pay now · R945\.00$/ })).toBeInTheDocument();
    // Settle-entire-bill must be entirely absent from the DOM —
    // collapsing the duplicate is the whole point.
    expect(screen.queryByRole('button', { name: /Settle entire bill/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pay next instalment/i })).toBeNull();
  });

  it('renders nothing when outstandingCount === 0', () => {
    const { container } = render(
      <PlanSettleAffordance
        planId="plan-1"
        outstandingCount={0}
        outstandingTotalCents={0}
        nextOutstanding={null}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        settleInstalment={noop as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        settleEntirePlan={noop as any}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('PlanSettleAffordance — 2+ outstanding instalments', () => {
  it('collapses by default — only a "Settle…" toggle is visible', () => {
    setup(3, 42_566, 127_700); // 3 instalments, next R425.66, sum R1,277.00
    // The toggle button exists; the two options are NOT rendered.
    const toggle = screen.getByRole('button', { name: /Settle…/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /Pay next instalment/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Settle entire bill/i })).toBeNull();
  });

  it('expanding the toggle reveals BOTH options with DIFFERENT amounts (the meaningful choice)', () => {
    setup(3, 42_566, 127_700); // next R425.66, sum R1,277.00
    const toggle = screen.getByRole('button', { name: /Settle…/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Both options now in the DOM with distinct amounts.
    expect(screen.getByRole('button', { name: /Pay next instalment · R425\.66/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Settle entire bill · R1,277\.00/ })).toBeInTheDocument();
  });

  it('collapsing again hides the options', () => {
    setup(3, 42_566, 127_700);
    const toggle = screen.getByRole('button', { name: /Settle…/ });
    fireEvent.click(toggle); // expand
    fireEvent.click(toggle); // collapse
    expect(screen.queryByRole('button', { name: /Pay next instalment/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Settle entire bill/i })).toBeNull();
  });
});
