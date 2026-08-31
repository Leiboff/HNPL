import { describe, it, expect, vi } from 'vitest';

// Behavioural check on the gate itself: does it REDIRECT for the exact
// row shapes involved in the reported bug, and stay silent otherwise?
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
}));

const { requireTermsAccepted } = await import('@/lib/legal/termsGate');

const call = (row: unknown) => {
  try { (requireTermsAccepted as (r: unknown) => void)(row); return 'passed'; }
  catch (e) { return (e as Error).message; }
};

describe('requireTermsAccepted — behaviour', () => {
  it('refuses the bug row: a fresh Google patient with no acceptance', () => {
    expect(call({ role: 'patient', terms_accepted_at: null, onboarding_completed: false }))
      .toBe('REDIRECT:/auth/require-terms');
  });

  it('refuses a null role (trigger default is patient)', () => {
    expect(call({ role: null, terms_accepted_at: null, onboarding_completed: false }))
      .toBe('REDIRECT:/auth/require-terms');
  });

  it('refuses a missing row', () => {
    expect(call(null)).toBe('REDIRECT:/auth/require-terms');
  });

  it('passes an accepted patient', () => {
    expect(call({ role: 'patient', terms_accepted_at: '2026-08-01T00:00:00Z', onboarding_completed: false }))
      .toBe('passed');
  });

  it('passes a grandfathered patient', () => {
    expect(call({ role: 'patient', terms_accepted_at: null, onboarding_completed: true }))
      .toBe('passed');
  });

  it('passes invited staff, who were never asked for customer T&Cs', () => {
    for (const role of ['practice_admin', 'practice_staff', 'practice_provider', 'admin', 'sales']) {
      expect(call({ role, terms_accepted_at: null, onboarding_completed: false }), role).toBe('passed');
    }
  });
});
