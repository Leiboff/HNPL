import { describe, it, expect } from 'vitest';
import { CARDS_SURFACE, cardCompletionRedirect } from './cardReturn';

// ─── Tests — card-flow return destination ───────────────────────────────
//
// The add-card flow must always return to the single card surface — on
// success AND on cancel — never bounce to a page the user never opened.

describe('CARDS_SURFACE', () => {
  it('is the Account tab (the one place cards live)', () => {
    expect(CARDS_SURFACE).toBe('/patient/account');
  });
});

describe('cardCompletionRedirect', () => {
  it('success → cards surface with the added flag', () => {
    expect(cardCompletionRedirect({ addedFlag: 'added' })).toBe('/patient/account?added=added');
  });

  it('already-saved → cards surface with the already flag', () => {
    expect(cardCompletionRedirect({ addedFlag: 'already' })).toBe('/patient/account?added=already');
  });

  it('cancelled → straight back to the cards surface, no banner', () => {
    expect(cardCompletionRedirect({ status: 'cancelled' })).toBe('/patient/account');
    expect(cardCompletionRedirect({ status: 'cancelled', addedFlag: 'added' })).toBe('/patient/account');
  });

  it('expired → straight back to the cards surface, no banner', () => {
    expect(cardCompletionRedirect({ status: 'expired' })).toBe('/patient/account');
  });

  it('no signal → cards surface, unflagged', () => {
    expect(cardCompletionRedirect({})).toBe('/patient/account');
  });
});
