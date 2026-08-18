import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Guard: the phone save path validates SERVER-SIDE ───────────────────
//
// The client blocks an invalid number, but the server action is the real
// gate. It must normalise via the shared validator, reject on failure, and
// never write the raw input.
//
// ─── RELOCATED, not weakened ──────────────────────────────────────────
//
// This pin has now followed the phone save path twice. It started on the
// profile route, moved here when Profile folded into Account, and has moved
// again — into app/patient/account/phoneChangeActions.ts — because a phone
// change now requires OTP re-verification of the new number.
//
// The old target, an inline `updateProfile` action doing
// `.update({ phone })`, is gone on purpose: writing profiles.phone without
// verifying it was the defect (phone_verified_at stayed set from the previous
// number, and dunning SMSed the unverified one). So the literal assertions
// could not survive.
//
// What the pin PROTECTS is unchanged and is asserted against the new target:
// the shared normaliser, a refusal rather than a write on failure, and never
// persisting the raw client string. Two things are added that the original
// could not check, because the old action wrote the number immediately:
//
//   • the validated value goes to the STAGING column, not to profiles.phone;
//   • the raw input is never written anywhere.

function read(p: string): string {
  return readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
}

const ACTIONS = stripComments(read('app/patient/account/phoneChangeActions.ts'));

describe('account phone save — server-side validation', () => {
  it('imports the shared SA-phone normaliser (never an inline regex)', () => {
    expect(ACTIONS).toMatch(/import\s*\{[^}]*normalizePhoneZA[^}]*\}\s*from\s*['"]@\/lib\/validation['"]/);
    // No hand-rolled phone regex anywhere. (The 6-digit OTP-format check is a
    // different thing and is allowed.)
    expect(ACTIONS).not.toMatch(/\+?27\[0-9\]|\\d\{9\}|0\[6-8\]/);
  });

  it('startPhoneChange normalises the phone and rejects an invalid one', () => {
    const start = ACTIONS.indexOf('export async function startPhoneChange');
    expect(start).toBeGreaterThan(-1);
    const body = ACTIONS.slice(start, ACTIONS.indexOf('export async function requestPhoneChangeOtp'));

    expect(body).toContain('normalizePhoneZA(');
    // A normalisation miss refuses rather than writing.
    expect(body).toMatch(/if\s*\(!normalized\)\s*return\s*\{\s*ok:\s*false,\s*code:\s*'invalid_phone'\s*\}/);
    // The write uses the VALIDATED value, and it goes to the staging column.
    expect(body).toContain('.update({ phone_pending: normalized })');
    // Never the raw client string, and never straight onto the live column.
    expect(body).not.toMatch(/phone_pending:\s*phoneRaw/);
    expect(body).not.toMatch(/\.update\(\{ phone:/);
  });

  it('the verify path re-reads the target from the profile rather than trusting a client value', () => {
    // The only client input to the verify action is the 6-digit code; the
    // phone it verifies comes from the staging column. A client-supplied phone
    // would reopen the SMS-burn vector migration 0055 closed.
    const start = ACTIONS.indexOf('export async function verifyPhoneChangeOtp');
    const body  = ACTIONS.slice(start, ACTIONS.indexOf('export async function cancelPhoneChange'));
    expect(body).toMatch(/\.select\('phone_pending'\)/);
    expect(body).toMatch(/normalizePhoneZA\(pending\)/);
    expect(body).toMatch(/\/\^\\d\{6\}\$\/\.test\(trimmed\)/);
  });
});
