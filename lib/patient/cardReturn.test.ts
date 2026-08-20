import { describe, it, expect } from 'vitest';
import { CARDS_SURFACE, ADD_CARD_PARAM, cardCompletionRedirect, cardRetryDestination } from './cardReturn';

// ─── Tests — card-flow return destination ───────────────────────────────
//
// The add-card flow must always return to the single card surface — on
// success AND on cancel — never bounce to a page the user never opened.
//
// RE-POINTED (2026-08-20): Payment cards moved off the account index onto
// its own route, /patient/account/pay, as part of the accordion→screens
// conversion. Landing on the index instead would make a just-added card
// invisible until the patient tapped back into "Payment cards" — exactly
// the "page they never navigated to" this module exists to prevent.

describe('CARDS_SURFACE', () => {
  it('is the Payment cards screen (the one place cards live)', () => {
    expect(CARDS_SURFACE).toBe('/patient/account/pay');
  });
});

describe('cardCompletionRedirect', () => {
  it('success → cards surface with the added flag', () => {
    expect(cardCompletionRedirect({ addedFlag: 'added' })).toBe('/patient/account/pay?added=added');
  });

  it('already-saved → cards surface with the already flag', () => {
    expect(cardCompletionRedirect({ addedFlag: 'already' })).toBe('/patient/account/pay?added=already');
  });

  it('cancelled → straight back to the cards surface, no banner', () => {
    expect(cardCompletionRedirect({ status: 'cancelled' })).toBe('/patient/account/pay');
    expect(cardCompletionRedirect({ status: 'cancelled', addedFlag: 'added' })).toBe('/patient/account/pay');
  });

  it('expired → straight back to the cards surface, no banner', () => {
    expect(cardCompletionRedirect({ status: 'expired' })).toBe('/patient/account/pay');
  });

  it('no signal → cards surface, unflagged', () => {
    expect(cardCompletionRedirect({})).toBe('/patient/account/pay');
  });
});

describe('cardRetryDestination', () => {
  it('re-launches a fresh add-card on the cards surface (not a re-poll URL)', () => {
    expect(cardRetryDestination()).toBe(`/patient/account/pay?${ADD_CARD_PARAM}=1`);
    expect(cardRetryDestination()).toBe('/patient/account/pay?addCard=1');
    // Must NOT point back at the completion route with an old checkout.
    expect(cardRetryDestination()).not.toContain('/complete');
    expect(cardRetryDestination()).not.toContain('checkoutId');
  });
});
