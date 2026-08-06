import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PaymentMethods from './PaymentMethods';
import type { CardRow } from './actions';

// ─── PaymentMethods — RULE 1 (default = new plans) + RULE 2 (delete guard) ──

const refresh = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter:       () => ({ refresh, replace }),
  usePathname:     () => '/patient/account',
  useSearchParams: () => new URLSearchParams(''),
}));

const CARD = (over: Partial<CardRow> & { id: string }): CardRow => ({
  card_brand: 'VISA', last_four: '4081', expiry_month: 4, expiry_year: 2030,
  cardholder_name: 'A Patient', is_default: false, created_at: '2026-01-01T00:00:00Z',
  ...over,
});

const noop = {
  initializeCardRegistration: vi.fn().mockResolvedValue({ error: null }),
};

beforeEach(() => { refresh.mockClear(); replace.mockClear(); });

describe('RULE 1 — default is for new plans only', () => {
  it('shows the "Default for new plans" microcopy on the default card', () => {
    render(
      <PaymentMethods
        initialCards={[CARD({ id: 'a', is_default: true })]}
        lockedCardIds={[]}
        {...noop}
        changeDefaultCard={vi.fn()}
        removeCard={vi.fn()}
      />,
    );
    expect(screen.getByText('Default for new plans')).toBeTruthy();
  });

  it('"Make default" flips immediately (no consequence dialog) and notes new-plans scope', async () => {
    const changeDefaultCard = vi.fn().mockResolvedValue({ error: null, changed: true, oldLastFour: '1111', newLastFour: '4081' });
    render(
      <PaymentMethods
        initialCards={[CARD({ id: 'a', is_default: true, last_four: '1111' }), CARD({ id: 'b', is_default: false, last_four: '4081' })]}
        lockedCardIds={[]}
        {...noop}
        changeDefaultCard={changeDefaultCard}
        removeCard={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Make default'));
    await waitFor(() => expect(changeDefaultCard).toHaveBeenCalledWith('b'));
    // No dialog — the notice confirms the new-plans-only semantics.
    await waitFor(() => expect(screen.getByText(/Default for new plans is now •••• 4081/)).toBeTruthy());
    expect(screen.queryByText(/will collect from/)).toBeNull();
  });
});

describe('RULE 2 — delete guard', () => {
  it('a card collecting an active plan has Remove disabled, with the reason shown', () => {
    const removeCard = vi.fn();
    render(
      <PaymentMethods
        initialCards={[CARD({ id: 'a', is_default: true }), CARD({ id: 'b' })]}
        lockedCardIds={['a']}
        {...noop}
        changeDefaultCard={vi.fn()}
        removeCard={removeCard}
      />,
    );
    const removeBtn = screen.getByTestId('remove-card-a') as HTMLButtonElement;
    expect(removeBtn.disabled).toBe(true);
    expect(screen.getByText('Collecting an active plan — change the card on that plan first.')).toBeTruthy();
    // Clicking a locked Remove does nothing (no confirm, no server call).
    fireEvent.click(removeBtn);
    expect(screen.queryByText('Remove this card?')).toBeNull();
    expect(removeCard).not.toHaveBeenCalled();
  });

  it('a card not collecting any active plan can be removed (archive) — copy mentions the retained reference', async () => {
    const removeCard = vi.fn().mockResolvedValue({ error: null, archived: true, promotedDefaultId: null, promotedLastFour: null });
    render(
      <PaymentMethods
        initialCards={[CARD({ id: 'a', is_default: true }), CARD({ id: 'b', last_four: '2222' })]}
        lockedCardIds={[]}
        {...noop}
        changeDefaultCard={vi.fn()}
        removeCard={removeCard}
      />,
    );
    fireEvent.click(screen.getByTestId('remove-card-b'));
    expect(screen.getByText('Remove this card?')).toBeTruthy();
    expect(screen.getByText(/secure reference is kept for reconciliation/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('confirm-remove'));
    await waitFor(() => expect(removeCard).toHaveBeenCalledWith('b'));
    await waitFor(() => expect(screen.getByText('Card removed.')).toBeTruthy());
  });

  it('archiving the default surfaces the reassigned default in the notice', async () => {
    const removeCard = vi.fn().mockResolvedValue({ error: null, archived: true, promotedDefaultId: 'b', promotedLastFour: '2222' });
    render(
      <PaymentMethods
        initialCards={[CARD({ id: 'a', is_default: true }), CARD({ id: 'b', last_four: '2222' })]}
        lockedCardIds={[]}
        {...noop}
        changeDefaultCard={vi.fn()}
        removeCard={removeCard}
      />,
    );
    fireEvent.click(screen.getByTestId('remove-card-a'));
    fireEvent.click(screen.getByTestId('confirm-remove'));
    await waitFor(() => expect(screen.getByText(/Default for new plans is now •••• 2222/)).toBeTruthy());
  });

  it('a server-side rejection (adversarial direct call) surfaces the block message', async () => {
    const removeCard = vi.fn().mockResolvedValue({ error: 'Collecting an active plan — change the card on that plan first.' });
    render(
      <PaymentMethods
        initialCards={[CARD({ id: 'a', is_default: true }), CARD({ id: 'b' })]}
        lockedCardIds={[]}  /* UI didn't lock it, but the server still rejects */
        {...noop}
        changeDefaultCard={vi.fn()}
        removeCard={removeCard}
      />,
    );
    fireEvent.click(screen.getByTestId('remove-card-b'));
    fireEvent.click(screen.getByTestId('confirm-remove'));
    await waitFor(() =>
      expect(screen.getAllByText('Collecting an active plan — change the card on that plan first.').length).toBeGreaterThan(0),
    );
  });
});
