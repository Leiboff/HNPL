// ─── CLOSURE — audit 2026-09-02, finding A-03 ─────────────────────────────
//
// This file began as the adversarial PROOF of A-03 and is now its closure.
// The assertions are inverted in place, deliberately: the chain's steps are
// the properties worth pinning, and a future change that reopens any one of
// them fails the test that describes the attack it enables.
//
// ─── THE CHAIN THAT WAS ───────────────────────────────────────────────────
//
// `initiateCheckout` established the caller's session by RESETTING the
// target account's password and signing in with the value it had just set:
//
//     const sessionTempPwd = generateTempPassword();
//     await svc.auth.admin.updateUserById(userId, { password: sessionTempPwd });
//     await supabaseAuth.auth.signInWithPassword({ email, password: sessionTempPwd });
//
// Fine when `userId` was an account the action itself had just created. An
// account takeover when it was an EXISTING patient — which is exactly what
// `discriminateExistingUser` returned 'reuse' for whenever the plan behind
// the token was already bound to that account.
//
// A plan reaches that state by design. `resolveBillIdentity` (case C, QR
// delivery) stamps `plans.patient_id` with the owner of the SA ID number the
// practice typed, and `issueCounterSession` / `createBill` then hand the
// practice a `checkout_sessions` token, rendered as a QR on the practice's
// own screen. On the session path `normalizedEmail` came from `input.email`
// — the caller's, not the bill's.
//
// So: a practice raised a QR bill against a returning patient's ID number,
// then POSTed that token to `initiateCheckout` with the patient's email and
// a phone number of its own choosing. The result was
//
//   • the patient's password destroyed (they were locked out),
//   • a live session as the patient in the caller's browser,
//   • and, before that, `profiles` upserted with the caller's first name,
//     last name, phone and phone_verified_at over the patient's own.
//
// ─── WHAT CLOSED IT ───────────────────────────────────────────────────────
//
// Three independent properties, each asserted below, because the chain only
// needed one of them to hold to run:
//
//   1. THE DOOR. `discriminateExistingUser` takes the token kind. On the
//      POS/QR (session) door an account that already exists is never reused
//      — the holder is asked to sign in, the one thing a practice cannot do
//      on the patient's behalf. And all refusals are ONE message, so the
//      response is no longer an oracle for which addresses hold accounts.
//   2. THE MINT. No password is written anywhere in this action's session
//      path. A magic-link `hashed_token` is generated and redeemed instead —
//      mutation-free, the same shape the F-07 fix adopted on
//      /checkout/[token]/complete. So even a reused account keeps its
//      credentials.
//   3. THE WRITE. The profile upsert refuses outright if it is ever reached
//      with an existing account on a session token, rather than trusting
//      property 1 from another file.
//
// Step 1 of the chain (resolveBillIdentity case C) is NOT changed and is
// still asserted as-is. Binding a QR bill to the ID owner is the correct
// behaviour — it is what lets a returning patient pay at a till. It was only
// dangerous because of what came after it.

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

describe('A-03 step 1 — a QR bill still binds the plan to an existing patient', () => {
  it('resolveBillIdentity case C stamps the ID owner under QR delivery', () => {
    // Unchanged, and correct: this is what lets a returning patient pay a
    // till bill at all. It is a precondition of the chain, not the defect.
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

describe('A-03 step 2 CLOSED — the session door never reuses an existing account', () => {
  it('the exact input that used to return reuse now returns require-login', () => {
    // Plan bound to the victim (step 1), victim's email supplied by the
    // caller, token from the practice's own QR panel.
    const decision = discriminateExistingUser(
      { id: 'victim-user-id', email_confirmed_at: '2026-01-01T00:00:00Z' },
      'victim-user-id',        // plans.patient_id, stamped at step 1
      'session',
    );
    expect(decision).toEqual({ action: 'require-login', existingUserId: 'victim-user-id' });
  });

  it('an UNCONFIRMED account is not adopted on this door either', () => {
    // The orphan carve-out was the second way in: no binding requirement at
    // all, so any unconfirmed row at a guessed address was reusable.
    const decision = discriminateExistingUser(
      { id: 'stale-user-id', email_confirmed_at: null },
      null,
      'session',
    );
    expect(decision).toEqual({ action: 'require-login', existingUserId: 'stale-user-id' });
  });

  it('the emailed-invitation door still reuses — that is a magic link, not a takeover', () => {
    // The fix is scoped to the door, not to reuse. On an invitation the email
    // comes off the invitation row, so handing the holder a session for that
    // address is equivalent to emailing them a link.
    const decision = discriminateExistingUser(
      { id: 'victim-user-id', email_confirmed_at: '2026-01-01T00:00:00Z' },
      'victim-user-id',
      'invitation',
    );
    expect(decision).toEqual({ action: 'reuse', userId: 'victim-user-id' });
  });

  it('and a walk-in with no account still gets one at the till', () => {
    expect(discriminateExistingUser(null, null, 'session')).toEqual({ action: 'create-new' });
  });
});

describe('A-03 step 3 CLOSED — no password is written, and the mint is mutation-free', () => {
  const body = initiateCheckoutBody();

  it('the email is STILL caller-supplied on the counter-session path', () => {
    // Not fixed here, and it does not need to be — this is what makes the
    // token kind the load-bearing fact. Asserted so the reasoning above
    // stays true of the code: if this ever became bill-derived, the door
    // check would be belt-and-braces rather than the fix.
    expect(body).toMatch(/const emailInput = \(input\.email \?\? ''\)/);
    expect(body).toMatch(/normalizedEmail = emailInput/);
  });

  it('FIXED: the action never sets a password on any account it signs in', () => {
    // The whole class, not just the reuse branch: no updateUserById with a
    // password anywhere, and no signInWithPassword to consume one.
    expect(body).not.toMatch(/updateUserById/);
    expect(body).not.toMatch(/signInWithPassword/);
    expect(body).not.toMatch(/sessionTempPwd/);
  });

  it('FIXED: the session comes from a magic-link hashed_token, redeemed via verifyOtp', () => {
    expect(body).toMatch(/generateLink\(\{\s*\n?\s*type:\s*'magiclink'/);
    expect(body).toMatch(/link\?\.properties\?\.hashed_token/);
    expect(body).toMatch(/verifyOtp\(\{\s*\n?\s*token_hash:\s*hashedToken/);
    // Fails closed: no token, no session, no checkout.
    expect(body).toMatch(/if\s*\(linkErr \|\| !hashedToken\)[\s\S]{0,140}return \{ ok: false/);
  });

  it('the ONE createUser is still the only account creation, and still marks isNewUser', () => {
    // generateTempPassword survives for exactly one purpose — the initial
    // password of an account this call creates, which nobody ever uses.
    expect(body).toMatch(/auth\.admin\.createUser\(/);
    expect(body).toMatch(/isNewUser\s*=\s*true/);
  });

  it('FIXED: the profile upsert refuses an existing account on a session token', () => {
    // Property 3 — local to the statement that does the damage, so the write
    // is safe even if the rule in _lib/discriminate.ts is later relaxed.
    const upsertAt = body.indexOf('.upsert(profileFields');
    expect(upsertAt).toBeGreaterThan(-1);
    const guard = body.slice(Math.max(0, upsertAt - 900), upsertAt);
    expect(guard).toMatch(/if\s*\(!isNewUser && resolved\.kind === 'session'\)/);
    expect(guard).toMatch(/return signInRequired\(/);
    // Still the fields A-03 rewrote — the point is the guard above them.
    expect(body).toMatch(/first_name:\s*firstName\.trim\(\)/);
    expect(body).toMatch(/phone:\s*normalizedPhone/);
    expect(body).toMatch(/phone_verified_at:\s*phoneVerifiedAt/);
  });

  it('every refusal on THIS door is the same message — no enumeration oracle', () => {
    // Three distinguishable strings (unknown address / real-but-wrong
    // address / the address on this bill) let a QR-token holder walk a
    // candidate list until one came back different. Now one helper, and on a
    // session token it has exactly one string.
    const refusals = body.match(/return signInRequired\(/g) ?? [];
    expect(refusals.length).toBeGreaterThanOrEqual(3);
    expect(ACTIONS).toMatch(/function signInRequired\(/);
    const helper = ACTIONS.slice(ACTIONS.indexOf('function signInRequired('));
    expect(helper).toMatch(/'Please sign in to continue with this bill\.'/);
    // The one specific message that survives is gated on the INVITATION door,
    // where the caller cannot choose the address and so has nothing to probe.
    // If that gate is ever dropped, the oracle is back on the QR door.
    expect(helper).toMatch(/opts\.saIdDuplicate && tokenKind === 'invitation'/);
  });

  it('the phone gate is still keyed on the caller-supplied number', () => {
    // Unchanged and still worth knowing: this proves control of a phone, not
    // of the account. It is no longer load-bearing for A-03 — the door is —
    // but do not mistake it for identity.
    expect(body).toMatch(/\.eq\('phone_e164',\s*normalizedPhone\)/);
  });
});
