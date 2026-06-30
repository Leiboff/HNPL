import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PlanPickerCards from './PlanPickerCards';

// ─── Tests — PlanPickerCards (presentation + selection wiring) ─────────
//
// This component is a presentation-only restyle of the pay-in-2 vs
// pay-in-3 choice on /checkout/[token]. The amounts come from the
// caller (CheckoutForm.previewInstalments) — this component MUST NOT
// recompute. These tests pin the contract:
//
//   • Both cards render with the per-instalment amount from the
//     supplied `perInstalmentAmount` function — proving no internal
//     recomputation (we inject a stub and assert it's called).
//   • "No interest or fees" appears on BOTH cards — load-bearing
//     legal/trust posture.
//   • Honest cadence copy: "N payments on your salary dates" — no
//     "/month" wording (we'd be lying; BetterNow's model is salary-
//     dates, not monthly).
//   • Selecting a card calls setPlanType with the right value AND
//     the only state changes are presentational (aria-checked,
//     data-active) — selection feeds the existing parent state,
//     which is what the existing initiateCheckout server action
//     reads.

function setup(opts: Partial<React.ComponentProps<typeof PlanPickerCards>> = {}) {
  const setPlanType         = vi.fn();
  const perInstalmentAmount = vi.fn((n: 2 | 3) => (n === 2 ? 1500 : 1000));
  render(
    <PlanPickerCards
      totalAmount={3000}
      planType={2}
      setPlanType={setPlanType}
      perInstalmentAmount={perInstalmentAmount}
      {...opts}
    />,
  );
  return { setPlanType, perInstalmentAmount };
}

describe('PlanPickerCards — both options render with the supplied per-instalment amount', () => {
  it('renders TWO selectable cards (one per plan size)', () => {
    setup();
    expect(screen.getByTestId('plan-card-2')).toBeTruthy();
    expect(screen.getByTestId('plan-card-3')).toBeTruthy();
  });

  it('displays the per-instalment amount from the SUPPLIED function — no internal recomputation', () => {
    const { perInstalmentAmount } = setup();
    // Both cards consulted the function once each.
    expect(perInstalmentAmount).toHaveBeenCalledWith(2);
    expect(perInstalmentAmount).toHaveBeenCalledWith(3);
    // And the formatted amounts appear in the DOM.
    expect(screen.getByText('R1,500.00')).toBeTruthy();
    expect(screen.getByText('R1,000.00')).toBeTruthy();
  });

  it('displays the bill total as a secondary (de-emphasised) line — present on both cards', () => {
    setup({ totalAmount: 3000 });
    // Both cards show "Total: R3,000.00" — assert both nodes exist.
    const totalMentions = screen.getAllByText((_, node) => {
      if (!node) return false;
      const t = node.textContent ?? '';
      return /Total:\s*R3,000\.00/.test(t);
    });
    // The total appears at least twice (once per card). It can match
    // more than two because parents reflow child text — we just need
    // >= 2 matching containers.
    expect(totalMentions.length).toBeGreaterThanOrEqual(2);
  });
});

describe('PlanPickerCards — load-bearing trust + honest cadence copy', () => {
  it('"No interest or fees" appears on BOTH cards', () => {
    setup();
    const matches = screen.getAllByText('No interest or fees');
    expect(matches).toHaveLength(2);
  });

  it('uses honest salary-date cadence — NOT "/month" or "per month"', () => {
    setup();
    expect(screen.getByText(/× 2 payments on your salary dates/)).toBeTruthy();
    expect(screen.getByText(/× 3 payments on your salary dates/)).toBeTruthy();
    // Hard-block monthly wording — if anyone retypes "/month" or
    // "per month" we catch it here.
    expect(screen.queryByText(/\/month/)).toBeNull();
    expect(screen.queryByText(/per month/i)).toBeNull();
  });

  it('term badge reads "N payments" on each card (the navy/teal pill)', () => {
    setup();
    // Each card has its own "{n} payments" pill. The pill text is
    // separate from the cadence copy ("× 3 payments on your salary
    // dates") — the pill is exactly "3 payments". Use a regex anchored
    // to whitespace so the cadence line doesn't match the pill check.
    const pills = screen.getAllByText(/^[23] payments$/);
    expect(pills.length).toBe(2);
  });

  it('shows the reassuring framing headline above the cards', () => {
    setup();
    expect(screen.getByText('Choose the option that works for you')).toBeTruthy();
  });
});

describe('PlanPickerCards — diff scope: no payment-logic imports', () => {
  // This is a presentation-only restyle. The component MUST NOT import
  // anything from lib/finance, the checkout actions, or paystack —
  // amounts come from the caller via the `perInstalmentAmount` prop;
  // the action is called by the parent. If a future edit pulls in a
  // financial import here, this test catches it.
  it('PlanPickerCards source has zero financial / payment-action imports', () => {
    // Read the file at test time so the assertion follows the real
    // source, not a stale snapshot.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolve } = require('node:path') as typeof import('node:path');
    const src = readFileSync(
      resolve(process.cwd(), 'app/checkout/[token]/_components/PlanPickerCards.tsx'),
      'utf8',
    );
    expect(src).not.toMatch(/from\s+['"]@\/lib\/finance/);
    expect(src).not.toMatch(/from\s+['"]@\/lib\/paystack/);
    expect(src).not.toMatch(/from\s+['"]\.\.\/actions/);
    expect(src).not.toMatch(/from\s+['"]\.\.\/_lib/);
    // No client-side instalment splitting either — the math lives in
    // the parent (previewInstalments / lib/finance.splitInstalments).
    expect(src).not.toMatch(/splitInstalments|calculatePaymentDates/);
  });
});

describe('PlanPickerCards — selection wires to setPlanType (the existing parent state)', () => {
  it('clicking the 3-payments card calls setPlanType(3)', () => {
    const { setPlanType } = setup({ planType: 2 });
    fireEvent.click(screen.getByTestId('plan-card-3'));
    expect(setPlanType).toHaveBeenCalledWith(3);
    expect(setPlanType).toHaveBeenCalledTimes(1);
  });

  it('clicking the 2-payments card calls setPlanType(2)', () => {
    const { setPlanType } = setup({ planType: 3 });
    fireEvent.click(screen.getByTestId('plan-card-2'));
    expect(setPlanType).toHaveBeenCalledWith(2);
  });

  it('the active card has aria-checked=true and data-active=true; the other is false', () => {
    setup({ planType: 3 });
    const two   = screen.getByTestId('plan-card-2');
    const three = screen.getByTestId('plan-card-3');
    expect(two.getAttribute('aria-checked')).toBe('false');
    expect(two.getAttribute('data-active')).toBe('false');
    expect(three.getAttribute('aria-checked')).toBe('true');
    expect(three.getAttribute('data-active')).toBe('true');
  });

  it('cards use role="radio" inside a labelled radiogroup (a11y posture preserved)', () => {
    setup();
    const group = screen.getByRole('radiogroup', { name: /number of instalments/i });
    expect(group).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
  });
});
