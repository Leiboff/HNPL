import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── POS counter-session checkout — polymorphic token flow ─────────────
//
// /checkout/[token] now serves TWO token spaces: the existing emailed
// patient_invitations token, and a new POS counter checkout_sessions
// token (migration 0085) rendered as an on-screen QR. These tests pin
// the properties that have a real failure mode if regressed:
//
//   1. page.tsx tries the invitation RPC first, falls back to the
//      session RPC — never the reverse, and never both blindly.
//   2. A session-sourced token skips the email-based existing-account
//      detection entirely (no email signal exists for it) rather than
//      crashing or silently reusing invitation logic.
//   3. The SA ID is decrypted + masked SERVER-SIDE ONLY before it
//      reaches a client-rendered prop — plaintext never crosses that
//      boundary.
//   4. CheckoutForm renders the SA ID field as locked/read-only when
//      prefilledSaId is supplied, and the client submits '' (never a
//      real value) for that field on a session-sourced token —
//      initiateCheckout re-derives it server-side instead.
//   5. initiateCheckout's SA ID source and validation forks on
//      resolved.kind, and the encrypted session value is decrypted
//      server-side rather than trusting client input.

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const PAGE       = read('app/checkout/[token]/page.tsx');
const FORM       = read('app/checkout/[token]/CheckoutForm.tsx');
const ACTIONS     = read('app/checkout/[token]/actions.ts');
const COMPLETE_PAGE = read('app/checkout/[token]/complete/page.tsx');
const MIGRATION_SESSIONS = read('supabase/migrations/0085_checkout_sessions.sql');
const MIGRATION_OTP      = read('supabase/migrations/0086_phone_verification_pos_token.sql');

describe('page.tsx — polymorphic token resolution', () => {
  it('tries get_invitation_by_token first, then falls back to get_checkout_session_by_token', () => {
    const invIdx = PAGE.indexOf('get_invitation_by_token');
    const sessIdx = PAGE.indexOf('get_checkout_session_by_token');
    expect(invIdx).toBeGreaterThan(0);
    expect(sessIdx).toBeGreaterThan(invIdx);
  });

  it('skips email-based existing-account detection for a session-sourced token', () => {
    expect(PAGE).toMatch(/if\s*\(resolved\.kind\s*===\s*'invitation'\)\s*\{[\s\S]{0,50}if\s*\(planPatientId\)/);
  });

  it('decrypts + masks the SA ID server-side only, never passing the encrypted or plaintext value as a client prop', () => {
    expect(PAGE).toMatch(/import\s*\{\s*decryptId,\s*maskId\s*\}\s*from\s*'@\/lib\/idEncryption'/);
    expect(PAGE).toMatch(/maskId\(decryptId\(resolved\.row\.sa_id_number\)\)/);
    // The prop passed to CheckoutForm is the masked variable, not the
    // raw resolved row.
    expect(PAGE).toMatch(/prefilledSaId=\{maskedSaId\}/);
  });

  it('a decryption failure fails closed (invalid-link card), never falls through with a broken value', () => {
    const idx = PAGE.indexOf("maskedSaId = maskId(decryptId(resolved.row.sa_id_number))");
    expect(idx).toBeGreaterThan(0);
    const chunk = PAGE.slice(idx - 50, idx + 300);
    expect(chunk).toMatch(/catch/);
    expect(chunk).toMatch(/InvalidLinkCard/);
  });
});

describe('CheckoutForm — locked SA ID for a POS session', () => {
  it('renders the SA ID input as readOnly + disabled when prefilledSaId is set', () => {
    expect(FORM).toMatch(/prefilledSaId\s*\?\s*\(/);
    expect(FORM).toMatch(/readOnly[\s\S]{0,30}disabled/);
  });

  it('the SA ID validator no-ops when prefilledSaId is set (already validated at issuance)', () => {
    expect(FORM).toMatch(/if\s*\(prefilledSaId\)\s*return\s*null;/);
  });

  it('submits an empty saIdNumber for a session-sourced token — the server derives the real value', () => {
    expect(FORM).toMatch(/saIdNumber:\s*prefilledSaId\s*\?\s*''\s*:\s*details\.saIdNumber\.trim\(\)/);
  });
});

describe('initiateCheckout — SA ID + email resolution forks on token kind', () => {
  it('invitation kind validates client-typed saIdNumber and sources email from the resolved invitation', () => {
    expect(ACTIONS).toMatch(/if\s*\(resolved\.kind\s*===\s*'invitation'\)\s*\{/);
    expect(ACTIONS).toMatch(/validateSaId\(input\.saIdNumber\)/);
    expect(ACTIONS).toMatch(/normalizedEmail\s*=\s*resolved\.email;/);
  });

  it('session kind decrypts the session-stored SA ID server-side and requires a client-submitted email', () => {
    expect(ACTIONS).toMatch(/saIdPlain\s*=\s*decryptId\(resolved\.saIdNumber\)/);
    expect(ACTIONS).toMatch(/isValidEmail\(emailInput\)/);
  });

  it('resolveCheckoutToken tries patient_invitations before checkout_sessions', () => {
    const fnIdx = ACTIONS.indexOf('async function resolveCheckoutToken');
    expect(fnIdx).toBeGreaterThan(0);
    const body = ACTIONS.slice(fnIdx);
    const invTableIdx  = body.indexOf("from('patient_invitations')");
    const sessTableIdx = body.indexOf("from('checkout_sessions')");
    expect(invTableIdx).toBeGreaterThan(0);
    expect(sessTableIdx).toBeGreaterThan(invTableIdx);
  });

  it('resumeFirstInstalmentCapture also resolves via the shared polymorphic helper', () => {
    const fnIdx = ACTIONS.indexOf('export async function resumeFirstInstalmentCapture');
    expect(fnIdx).toBeGreaterThan(0);
    const body = ACTIONS.slice(fnIdx, fnIdx + 2000);
    expect(body).toMatch(/resolveCheckoutToken\(svc, token\)/);
  });
});

describe('migration 0085 — checkout_sessions table + RPCs', () => {
  it('creates the table with an encrypted sa_id_number column and a short-TTL stage machine', () => {
    expect(MIGRATION_SESSIONS).toMatch(/CREATE TABLE IF NOT EXISTS checkout_sessions/);
    expect(MIGRATION_SESSIONS).toMatch(/sa_id_number\s+TEXT\s+NOT NULL/);
    expect(MIGRATION_SESSIONS).toMatch(/stage\s+TEXT\s+NOT NULL DEFAULT 'created'/);
  });

  it('enables RLS with no anon/authenticated INSERT or UPDATE policy — service-role only writes', () => {
    expect(MIGRATION_SESSIONS).toMatch(/ALTER TABLE checkout_sessions ENABLE ROW LEVEL SECURITY/);
    expect(MIGRATION_SESSIONS).not.toMatch(/FOR INSERT/);
    expect(MIGRATION_SESSIONS).not.toMatch(/FOR UPDATE/);
  });

  it('get_checkout_session_by_token is SECURITY DEFINER, granted to anon, and excludes email from its return shape', () => {
    expect(MIGRATION_SESSIONS).toMatch(/CREATE OR REPLACE FUNCTION get_checkout_session_by_token/);
    expect(MIGRATION_SESSIONS).toMatch(/SECURITY DEFINER/);
    expect(MIGRATION_SESSIONS).toMatch(/GRANT EXECUTE ON FUNCTION get_checkout_session_by_token\(TEXT\) TO anon, authenticated/);
    const fnIdx = MIGRATION_SESSIONS.indexOf('CREATE OR REPLACE FUNCTION get_checkout_session_by_token');
    const fnEnd = MIGRATION_SESSIONS.indexOf('$$;', fnIdx);
    const fnBody = MIGRATION_SESSIONS.slice(fnIdx, fnEnd);
    expect(fnBody).not.toMatch(/\bemail\b/);
  });
});

describe('migration 0086 — phone OTP gate recognizes POS session tokens', () => {
  it('prepare_phone_verification checks BOTH patient_invitations and checkout_sessions liveness', () => {
    expect(MIGRATION_OTP).toMatch(/FROM patient_invitations/);
    expect(MIGRATION_OTP).toMatch(/FROM checkout_sessions/);
    expect(MIGRATION_OTP).toMatch(/stage IN \('created', 'scanned'\)/);
  });
});

describe('checkout completion route — checkout_sessions reaches a terminal stage', () => {
  it('advances checkout_sessions.stage to completed by plan_id (idempotent; no-op for an invitation-sourced plan)', () => {
    const idx = COMPLETE_PAGE.indexOf("from('checkout_sessions')");
    expect(idx).toBeGreaterThan(0);
    const chunk = COMPLETE_PAGE.slice(idx, idx + 200);
    expect(chunk).toMatch(/stage:\s*'completed'/);
    expect(chunk).toMatch(/\.eq\('plan_id',\s*planId\)/);
    expect(chunk).toMatch(/\.neq\('stage',\s*'completed'\)/);
  });
});
