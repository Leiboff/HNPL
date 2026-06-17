import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── viewed_at stamp wiring (source-text regression) ──────────────────────
//
// The patient_invitations.viewed_at signal drives the practice-side
// "Viewed" lifecycle chip. The /checkout/[token] page is the ONLY
// surface that stamps it, and a refactor that drops the call would
// silently regress the feature: the chip would stay on "Sent" forever
// while patients are clicking the link.
//
// These tests pin the three properties of that wiring that have a
// real failure mode if regressed:
//
//   1. The page calls the SECURITY DEFINER RPC `stamp_invitation_viewed`
//      with the URL token. (Direct UPDATE on the table by the anon
//      role is impossible — see migration 0049 — so the only way is
//      via this RPC.)
//   2. The call is wrapped in try/catch. A transient stamp failure
//      MUST NOT block the patient from reaching the form, since
//      checkout is the revenue path.
//   3. The migration grants EXECUTE on the RPC to `anon` (the patient
//      visiting /checkout/[token] is unauthenticated). Without the
//      grant the call would 401 in production.
//
// We assert these as source-text regressions — fast, no DB, no
// dependency on Supabase auth. The runtime call itself is exercised
// in the integration / smoke tests.

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const PAGE      = read('app/checkout/[token]/page.tsx');
const MIGRATION = read('supabase/migrations/0050_invitation_viewed_and_realtime.sql');

describe('Checkout page stamps viewed_at via the RPC', () => {
  it('calls supabase.rpc("stamp_invitation_viewed", { p_token: token })', () => {
    expect(PAGE).toMatch(/stamp_invitation_viewed/);
    expect(PAGE).toMatch(/p_token\s*:\s*token/);
  });

  it('wraps the RPC call in a try/catch so a stamp failure never blocks checkout', () => {
    // The stamp block lives between the row-resolution code and the
    // form-render JSX. Find it and assert the try/catch is in place.
    expect(PAGE).toMatch(
      /try\s*\{[\s\S]*?stamp_invitation_viewed[\s\S]*?\}\s*catch/,
    );
  });

  it('logs but does not re-throw (the patient flow continues either way)', () => {
    // Either branch (the soft Postgrest error OR the throw catch)
    // funnels into a warn-style log, never a redirect or render bail.
    expect(PAGE).toMatch(/console\.warn\([^)]*stamp_invitation_viewed/);
  });
});

describe('Migration 0050 ships an idempotent stamp RPC + the realtime publication', () => {
  it('declares an UPDATE that guards on viewed_at IS NULL (idempotent by construction)', () => {
    expect(MIGRATION).toMatch(/UPDATE\s+patient_invitations/);
    expect(MIGRATION).toMatch(/SET\s+viewed_at\s*=\s*now\(\)/);
    expect(MIGRATION).toMatch(/viewed_at\s+IS\s+NULL/);
  });

  it('declares the function as SECURITY DEFINER with SET search_path = public', () => {
    expect(MIGRATION).toMatch(/SECURITY\s+DEFINER/);
    expect(MIGRATION).toMatch(/SET\s+search_path\s*=\s*public/);
  });

  it('grants EXECUTE to anon AND authenticated (patient is anon at /checkout/[token])', () => {
    expect(MIGRATION).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+stamp_invitation_viewed\(TEXT\)\s+TO\s+anon\s*,\s*authenticated/,
    );
  });

  it('adds patient_invitations AND plans to the supabase_realtime publication', () => {
    expect(MIGRATION).toMatch(/ALTER\s+PUBLICATION\s+supabase_realtime\s+ADD\s+TABLE\s+patient_invitations/);
    expect(MIGRATION).toMatch(/ALTER\s+PUBLICATION\s+supabase_realtime\s+ADD\s+TABLE\s+plans/);
  });

  it('adds patient_invitations.viewed_at idempotently (ADD COLUMN IF NOT EXISTS)', () => {
    expect(MIGRATION).toMatch(
      /ALTER\s+TABLE\s+patient_invitations[\s\S]*?ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+viewed_at/,
    );
  });
});
