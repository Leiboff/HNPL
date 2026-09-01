import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── ADVERSARIAL: the THIRD way to get an account ─────────────────────
//
// The terms gate was built and tested around two front doors — the email
// signup action and the Google callback. There is a third, and it is not
// obviously a signup at all: /checkout/[token].
//
// initiateCheckout runs `svc.auth.admin.createUser` for a patient who has
// never had an account (the 'create-new' fork), and then upserts a
// profile row that stamps profiles.terms_accepted_at. A patient who
// clicks an emailed bill link and pays becomes a registered user without
// ever visiting /signup.
//
// WHAT THIS FILE WAS WRITTEN AFTER FINDING
//
// That path had no server-side gate. CheckoutForm validated its "I agree"
// checkbox client-side and did NOT send the result;
// InitiateCheckoutInput had no field for it; and the profile upsert
// stamped terms_accepted_at with `new Date().toISOString()`
// unconditionally. So a request that skipped the form — a hand-built
// action POST, or the same page with the checkbox deleted from the DOM —
// produced an account AND an audit record asserting an agreement that no
// server had seen.
//
// Migration 0081's own header names this exact situation as the thing it
// was written to fix ("the payment-plan 'I agree' tick was captured
// CLIENT-SIDE ONLY"). It made the acceptance RECORDED. It did not make it
// REQUIRED, and on this path nothing else did either.
//
// These tests attack the gate that now exists. It sits at the very top of
// the action, ahead of token resolution, so they need no database: the
// refusal happens before anything is touched, which is the property being
// asserted.

const createUserSpy = vi.fn();

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: vi.fn() }) }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

// Any reach for the database at all is a failure of these tests' premise:
// the gate is meant to refuse before a client is even built.
const fromSpy = vi.fn(() => { throw new Error('reached the database past the terms gate'); });
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: fromSpy,
    auth: { admin: { createUser: createUserSpy } },
  }),
}));

vi.mock('@/lib/payments/provider', () => ({ getPaymentProvider: () => ({ name: 'test' }) }));

import { initiateCheckout, type InitiateCheckoutInput } from './actions';

const VALID: Omit<InitiateCheckoutInput, 'termsAccepted'> = {
  token:      'a-real-looking-token',
  firstName:  'Adver',
  lastName:   'Sarial',
  saIdNumber: '9202204720082',
  phone:      '0821234567',
  planType:   3,
  salaryDay:  25,
};

/** POST the action with an arbitrary termsAccepted, as a crafted request would. */
function post(termsAccepted: unknown) {
  return initiateCheckout({ ...VALID, termsAccepted } as unknown as InitiateCheckoutInput);
}

beforeEach(() => {
  createUserSpy.mockClear();
  fromSpy.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('ATTACK — register through checkout without agreeing', () => {
  it.each([
    ['omitted entirely',    undefined],
    ['false',               false],
    ['null',                null],
    ['0',                   0],
    ['an empty string',     ''],
  ])('%s is refused, and no account is created', async (_label, value) => {
    const res = await post(value);

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ error: expect.stringMatching(/accept the payment-plan terms/i) });
    expect(createUserSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['the STRING "false"',  'false'],
    ['the STRING "0"',      '0'],
    ['the STRING "no"',     'no'],
    ['an empty object',     {}],
    ['an empty array',      []],
    ['the number 1',        1],
  ])('%s is truthy but is still not an agreement', async (_label, value) => {
    // The `boolean` annotation on InitiateCheckoutInput is erased at
    // runtime. A gate written as `if (!termsAccepted)` would accept every
    // one of these and stamp terms_accepted_at from a value it never read.
    const res = await post(value);

    expect(res.ok).toBe(false);
    expect(createUserSpy).not.toHaveBeenCalled();
  });

  it('refuses BEFORE the token is resolved — nothing is read, nothing is created', async () => {
    // Ordering is the point. A gate placed after token resolution would
    // still refuse, but only after using the action as an oracle for
    // which checkout tokens are live.
    await post(false);

    expect(fromSpy).not.toHaveBeenCalled();
    expect(createUserSpy).not.toHaveBeenCalled();
  });

  it('a valid-looking token does not buy a way past the tick', async () => {
    const res = await initiateCheckout({
      ...VALID, token: 'definitely-a-real-token', termsAccepted: false,
    } as InitiateCheckoutInput);

    expect(res.ok).toBe(false);
    expect(createUserSpy).not.toHaveBeenCalled();
  });
});

describe('the form actually SENDS the tick it collects', () => {
  // The gate is only as good as the payload reaching it. A form that
  // validates the checkbox and then drops it on the floor turns every
  // honest checkout into the refusal above — which is why this is pinned
  // rather than left to the type-checker, whose complaint would be about
  // the call site being incomplete, not about the value being the one the
  // patient actually ticked.
  const FORM = readFileSync(path.join(__dirname, 'CheckoutForm.tsx'), 'utf8');

  it('passes details.termsAccepted into initiateCheckout', () => {
    expect(FORM).toMatch(/termsAccepted:\s*details\.termsAccepted/);
  });

  it('still gates the step client-side too, so the refusal is not the first feedback', () => {
    expect(FORM).toMatch(/Please accept the payment-plan terms/);
  });
});
