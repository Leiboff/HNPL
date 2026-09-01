// ─── ADVERSARIAL PROOF — audit 2026-09-02, finding A-03 ───────────────────
//
// THE CHAIN
//
// `initiateCheckout` establishes the caller's session by RESETTING the target
// account's password and signing in with the value it just set:
//
//     const sessionTempPwd = generateTempPassword();
//     await svc.auth.admin.updateUserById(userId, { password: sessionTempPwd });
//     await supabaseAuth.auth.signInWithPassword({ email, password: sessionTempPwd });
//
// That is fine when `userId` is an account the action itself just created. It
// is an account takeover when `userId` is an EXISTING patient — which is
// exactly what `discriminateExistingUser` returns 'reuse' for whenever the
// plan behind the token is already bound to that account.
//
// A plan reaches that state by design. `resolveBillIdentity` (case C, QR
// delivery) stamps `plans.patient_id` with the owner of the SA ID number the
// practice typed, and `issueCounterSession` / `createBill` then hand the
// practice a `checkout_sessions` token, rendered as a QR on the practice's
// own screen. On the session path `normalizedEmail` comes from
// `input.email` — the caller's, not the bill's.
//
// So: a practice raises a QR bill against a returning patient's ID number,
// then POSTs that token to `initiateCheckout` with the patient's email
// address and a phone number of its own choosing. The result is
//
//   • the patient's password destroyed (they are locked out),
//   • a live session as the patient in the caller's browser,
//   • and, before that, `profiles` upserted with the caller's first name,
//     last name, phone and phone_verified_at over the patient's own.
//
// The phone-OTP precondition is not a barrier: the caller supplies the phone
// and receives the SMS, and finding A-01 removes even that step.
//
// This file asserts the structural facts of the chain, following the
// convention set by replay-guard.test.ts — standing up `initiateCheckout`'s
// auth-admin, Peach and cookie calls would test the mocks rather than the
// action. The decision that opens the door IS pure, so that half is
// exercised behaviourally.
//
// WHEN THIS IS FIXED: `initiateCheckout` must never mint a session for an
// account it did not create. Either refuse `reuse` outright and send the
// caller to /login?next=… (the branch already used for
// 'reject-organic-collision'), or mint a magic-link token via
// admin.generateLink and redeem it — the mutation-free shape the F-07 fix
// already adopted on /checkout/[token]/complete. Then invert the assertions
// below.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { discriminateExistingUser } from './_lib/discriminate';
import { resolveBillIdentity } from '@/lib/patients/billIdentity';

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

const ACTIONS = read('app/checkout/[token]/actions.ts');

function initiateCheckoutBody(): string {
  const start = ACTIONS.indexOf('export async function initiateCheckout');
  expect(start).toBeGreaterThan(-1);
  const next = ACTIONS.indexOf('export async function', start + 1);
  return ACTIONS.slice(start, next === -1 ? undefined : next);
}

describe('A-03 step 1 — a QR bill binds the plan to an existing patient', () => {
  it('resolveBillIdentity case C stamps the ID owner under QR delivery', () => {
    const decision = resolveBillIdentity({
      idOwner:    { id: 'victim-user-id', email: 'victim@example.com' },
      emailOwner: null,
      typedEmail: null,          // QR delivery collects no address
      delivery:   'qr',
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.case).toBe('C');
      // plans.patient_id / applications.patient_id get this value.
      expect(decision.patientId).toBe('victim-user-id');
    }
  });
});

describe('A-03 step 2 — discriminateExistingUser returns reuse for that account', () => {
  it('a CONFIRMED existing account is reused when the plan is already bound to it', () => {
    const decision = discriminateExistingUser(
      { id: 'victim-user-id', email_confirmed_at: '2026-01-01T00:00:00Z' },
      'victim-user-id',        // plans.patient_id, stamped at step 1
    );
    // Note which branch this is NOT: the confirmed-account collision guard
    // below only fires when the plan is bound to somebody else.
    expect(decision).toEqual({ action: 'reuse', userId: 'victim-user-id' });
  });

  it('the collision guard that would have refused only fires on a DIFFERENT account', () => {
    const decision = discriminateExistingUser(
      { id: 'victim-user-id', email_confirmed_at: '2026-01-01T00:00:00Z' },
      'someone-else',
    );
    expect(decision.action).toBe('reject-organic-collision');
  });

  it('an UNCONFIRMED account is reused with no binding requirement at all', () => {
    const decision = discriminateExistingUser(
      { id: 'stale-user-id', email_confirmed_at: null },
      null,
    );
    expect(decision).toEqual({ action: 'reuse', userId: 'stale-user-id' });
  });
});

describe('A-03 step 3 — initiateCheckout then resets the password and signs in', () => {
  const body = initiateCheckoutBody();

  it('the email is caller-supplied on the counter-session path', () => {
    // kind 'session' takes the address off the request body. kind
    // 'invitation' pins it to the invitation row — only the session path is
    // attacker-controlled.
    expect(body).toMatch(/const emailInput = \(input\.email \?\? ''\)/);
    expect(body).toMatch(/normalizedEmail = emailInput/);
  });

  it('reuse assigns the EXISTING account id with no ownership proof', () => {
    expect(body).toMatch(/decision\.action === 'reuse'/);
    expect(body).toMatch(/userId = decision\.userId/);
    // isNewUser stays false on this branch — the only thing that
    // distinguishes a created account from an appropriated one.
    expect(body).toMatch(/isNewUser\s*=\s*true/);
  });

  it('DEFECT: the password is reset unconditionally, reuse included', () => {
    expect(body).toMatch(/updateUserById\(\s*userId\s*,\s*\{\s*\n?\s*password:\s*sessionTempPwd/);
    // No isNewUser condition anywhere near the reset.
    const resetAt = body.indexOf('updateUserById');
    const window  = body.slice(Math.max(0, resetAt - 400), resetAt);
    expect(window).not.toMatch(/if\s*\(\s*isNewUser/);
  });

  it('DEFECT: the session is then minted for that account', () => {
    expect(body).toMatch(/signInWithPassword\(\{\s*\n?\s*email:\s*normalizedEmail/);
  });

  it('DEFECT: the profile upsert overwrites the existing account\'s identity fields', () => {
    // first_name / last_name / phone / phone_verified_at all come from the
    // request, and the upsert is unconditional on isNewUser.
    expect(body).toMatch(/first_name:\s*firstName\.trim\(\)/);
    expect(body).toMatch(/phone:\s*normalizedPhone/);
    expect(body).toMatch(/phone_verified_at:\s*phoneVerifiedAt/);
    expect(body).toMatch(/\.upsert\(profileFields, \{ onConflict: 'id' \}\)/);
    const upsertAt = body.indexOf('.upsert(profileFields');
    const window   = body.slice(Math.max(0, upsertAt - 600), upsertAt);
    expect(window).not.toMatch(/if\s*\(\s*isNewUser/);
  });

  it('and the phone gate it relies on is keyed on the caller-supplied number', () => {
    // Not the patient's number on file — whichever number the caller put in
    // the form and verified. See A-01 for why even that is optional.
    expect(body).toMatch(/\.eq\('phone_e164',\s*normalizedPhone\)/);
  });
});
