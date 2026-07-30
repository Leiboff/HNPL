import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Migration 0078 — refresh_card_token repointed to Peach column ────
//
// The 0041 RPC updated plans.paystack_authorization_code — a dead
// legacy column no active code path reads post-Peach swap (0076/0077).
// That made the "same card re-vaulted → refresh token everywhere it's
// used" safety net a silent no-op for every Peach plan: the cron would
// keep charging the stale registrationId.
//
// It also carried a pre-existing cross-plan overwrite bug: the WHERE
// scoped only by patient_id + status, so a card refresh could
// overwrite a DIFFERENT plan's token when the patient had two active
// plans on two physical cards.
//
// 0078 fixes both — repoint to plans.peach_registration_id, and scope
// the update by the OLD token so only the correct plans are touched.
// These pins lock the corrected shape at source-text level so a
// future refactor cannot re-introduce either bug.

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const MIG   = read('supabase/migrations/0078_refresh_card_token_peach_column.sql');
const MIG41 = read('supabase/migrations/0041_refresh_card_token_fn.sql');

describe('0078 — refresh_card_token targets plans.peach_registration_id', () => {
  it('CREATE OR REPLACE preserves the RPC signature (6 params, jsonb return)', () => {
    expect(MIG).toMatch(/CREATE OR REPLACE FUNCTION refresh_card_token\(\s*p_card_id\s+uuid/);
    expect(MIG).toMatch(/p_token\s+text/);
    expect(MIG).toMatch(/p_brand\s+text/);
    expect(MIG).toMatch(/p_last_four\s+text/);
    expect(MIG).toMatch(/p_expiry_month\s+int/);
    expect(MIG).toMatch(/p_expiry_year\s+int/);
    expect(MIG).toMatch(/RETURNS\s+jsonb/);
  });

  it('preserves SECURITY DEFINER + search_path pin', () => {
    expect(MIG).toMatch(/SECURITY DEFINER/);
    expect(MIG).toMatch(/SET search_path = public/);
  });

  it('UPDATEs plans.peach_registration_id (the live Peach column), NOT paystack_authorization_code', () => {
    expect(MIG).toMatch(/UPDATE plans\s+SET peach_registration_id\s*=\s*p_token/);
    // The dead-column write from 0041 must be gone.
    expect(MIG).not.toMatch(/UPDATE plans\s+SET paystack_authorization_code/);
    // The 0041 file (kept for history) is what it always was.
    expect(MIG41).toMatch(/UPDATE plans\s+SET paystack_authorization_code/);
  });
});

describe('0078 — cross-plan overwrite fix (token-scoped WHERE)', () => {
  it('captures the OLD payment_methods.token before the UPDATE (v_old_token)', () => {
    // The SELECT into v_card includes `token`; a v_old_token snapshot
    // is taken before the payment_methods UPDATE so the plans UPDATE
    // can key on it.
    expect(MIG).toMatch(/SELECT[^;]*token\s*\s*INTO\s+v_card/);
    expect(MIG).toMatch(/v_old_token\s*:=\s*v_card\.token/);
    // v_old_token declaration must exist in DECLARE block.
    expect(MIG).toMatch(/v_old_token\s+text/);
  });

  it('scopes the plans UPDATE by peach_registration_id = v_old_token (NOT patient-wide)', () => {
    // Load-bearing pin: this is the fix for the cross-plan overwrite
    // bug. Any regression that drops the equality on the old token
    // would reintroduce the pre-existing bug.
    expect(MIG).toMatch(/WHERE\s+patient_id = v_card\.patient_id[\s\S]*?AND\s+peach_registration_id\s*=\s*v_old_token/);
  });

  it('guards against a null / unchanged old token (no-op)', () => {
    expect(MIG).toMatch(/IF\s+v_old_token\s+IS NOT NULL\s+AND\s+v_old_token\s+IS DISTINCT FROM\s+p_token\s+THEN/);
  });

  it('drops the is_default gate (Peach model has per-plan tokens; refresh applies whenever a plan\'s actual token changed)', () => {
    // The 0041 shape wrapped the plans UPDATE in `IF v_card.is_default THEN`.
    // Under Peach that's the wrong invariant — plan-token binding
    // is per-plan regardless of "default" status. Confirm the new
    // migration doesn't reintroduce the gate.
    expect(MIG).not.toMatch(/IF\s+v_card\.is_default\s+THEN[\s\S]*?UPDATE plans\s+SET peach_registration_id/);
    // Cross-check that 0041 DID have the gate (regression posture).
    expect(MIG41).toMatch(/IF\s+v_card\.is_default\s+THEN/);
  });

  it('still restricts to active / pending_first_payment plans (no historic overwrite)', () => {
    expect(MIG).toMatch(/status IN \('active', 'pending_first_payment'\)/);
  });
});

describe('0078 — unchanged surface', () => {
  it('payment_methods UPDATE still refreshes the same 5 columns (token/brand/last_four/expiry)', () => {
    expect(MIG).toMatch(/UPDATE payment_methods\s+SET token\s*=\s*p_token/);
    expect(MIG).toMatch(/card_brand\s*=\s*p_brand/);
    expect(MIG).toMatch(/last_four\s*=\s*p_last_four/);
    expect(MIG).toMatch(/expiry_month\s*=\s*p_expiry_month/);
    expect(MIG).toMatch(/expiry_year\s*=\s*p_expiry_year/);
    expect(MIG).toMatch(/reusable\s*=\s*true/);
  });

  it('still inserts a token_refreshed plan_event for each repointed plan', () => {
    expect(MIG).toMatch(/INSERT INTO plan_events[\s\S]{0,200}'token_refreshed'/);
    expect(MIG).toMatch(/'last_four',\s*p_last_four/);
    expect(MIG).toMatch(/'card_id',\s*p_card_id/);
  });

  it('return payload keeps { is_default, repointed_plans, plan_refs }', () => {
    expect(MIG).toMatch(/'is_default',\s*v_card\.is_default/);
    expect(MIG).toMatch(/'repointed_plans',\s*v_count/);
    expect(MIG).toMatch(/'plan_refs',\s*v_refs/);
  });

  it('grants EXECUTE to service_role (unchanged)', () => {
    expect(MIG).toMatch(/GRANT EXECUTE ON FUNCTION refresh_card_token\([\s\S]{0,80}\)\s*TO service_role/);
  });
});

describe('saveCardForPatient \'update\' path still calls refresh_card_token', () => {
  // Cross-file pin: any refactor that renames the RPC or bypasses it
  // in the dedupe 'update' branch would silently defeat this fix.
  const SAVE = read('lib/payments/peach/saveCardForPatient.ts');

  it('the update branch invokes supabase.rpc(\'refresh_card_token\', …)', () => {
    expect(SAVE).toMatch(/rpc\(\s*['"]refresh_card_token['"]/);
    // Pass the six params the RPC expects — order-independent, keys checked.
    expect(SAVE).toMatch(/p_card_id:\s*action\.cardId/);
    expect(SAVE).toMatch(/p_token:\s*card\.registrationId/);
    expect(SAVE).toMatch(/p_brand:\s*card\.brand/);
    expect(SAVE).toMatch(/p_last_four:\s*card\.last4/);
    expect(SAVE).toMatch(/p_expiry_month:\s*card\.expiryMonth/);
    expect(SAVE).toMatch(/p_expiry_year:\s*card\.expiryYear/);
  });
});
