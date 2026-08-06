// ─── Single source of truth for the card-management surface ─────────────
//
// v4 folds card management into the Account tab (its "How you pay"
// section). There is exactly ONE place that lists/manages cards — this
// constant names it, and every card-flow return path resolves through
// here so the add-card flow always lands the user back where they were,
// never on a page they never navigated to.
//
// The standalone /patient/payment-methods route redirects here; the
// Checkout V2 "add card" completion route resolves its redirect here too.

export const CARDS_SURFACE = '/patient/account';

/**
 * Where the "add card" completion route sends the browser once the
 * embedded widget hands back control.
 *
 *   • cancelled / expired  → straight back to the cards surface, no banner
 *                            (the shopper backed out; nothing was saved).
 *   • added / already      → the cards surface with the ?added flag so the
 *                            surface can show a one-shot confirmation toast.
 *   • anything else        → the cards surface, unflagged.
 *
 * Pure so it can be unit-tested without a browser or Peach round-trip.
 */
export function cardCompletionRedirect(opts: {
  status?:    string | null;
  addedFlag?: 'added' | 'already' | null;
}): string {
  if (opts.status === 'cancelled' || opts.status === 'expired') return CARDS_SURFACE;
  if (opts.addedFlag) return `${CARDS_SURFACE}?added=${opts.addedFlag}`;
  return CARDS_SURFACE;
}
