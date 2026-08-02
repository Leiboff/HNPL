import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Migration 0079 — change_default_card repointed to the Peach column ─
//
// The 0039/0040 RPC wrote plans.paystack_authorization_code — the dead
// legacy column no collection path reads post-Peach swap (0076/0077).
// "Change default card" therefore never moved future MIT charges to the
// new card (the cron kept hitting the old registrationId), and because
// `paystack_authorization_code IS DISTINCT FROM <token>` is TRUE for
// every Peach plan (the column is always NULL), it "repointed" ALL of
// the patient's plans and returned a FABRICATED repointed_plans count.
//
// 0079 is the sibling of the 0078 refresh_card_token fix: write
// plans.peach_registration_id, and TOKEN-SCOPE the update to the OLD
// default's token so only plans on the old card move (and the count is
// truthful). These pins lock the corrected shape at source level.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const MIG   = read('supabase/migrations/0079_change_default_card_peach_column.sql');
const MIG40 = read('supabase/migrations/0040_change_default_card_self_heal.sql');

describe('0079 — change_default_card targets plans.peach_registration_id', () => {
  it('CREATE OR REPLACE preserves the RPC signature (1 uuid param, jsonb return)', () => {
    expect(MIG).toMatch(/CREATE OR REPLACE FUNCTION change_default_card\(p_card_id uuid\)/);
    expect(MIG).toMatch(/RETURNS\s+jsonb/);
  });

  it('preserves SECURITY DEFINER + search_path pin', () => {
    expect(MIG).toMatch(/SECURITY DEFINER/);
    expect(MIG).toMatch(/SET search_path = public/);
  });

  it('UPDATEs plans.peach_registration_id (live column), NOT paystack_authorization_code', () => {
    expect(MIG).toMatch(/UPDATE plans\s+SET peach_registration_id\s*=\s*v_new\.token/);
    // The dead-column write from 0040 must be gone from the live statement.
    expect(MIG).not.toMatch(/SET paystack_authorization_code\s*=/);
    // 0040 (kept for history) is what it always was — regression cross-check.
    expect(MIG40).toMatch(/SET paystack_authorization_code\s*=\s*v_new\.token/);
  });
});

describe('0079 — token-scoped repoint (old-card → new-card only)', () => {
  it('scopes the plans UPDATE by peach_registration_id = the OLD default token', () => {
    // Load-bearing: only plans currently collecting from the OLD default
    // card are moved. A plan on a THIRD, different card is never clobbered.
    expect(MIG).toMatch(/WHERE\s+patient_id = v_user_id[\s\S]*?AND\s+peach_registration_id\s*=\s*v_old\.token/);
  });

  it('does NOT repoint patient-wide by the dead column (the 0040 shape)', () => {
    // 0040 scoped by `paystack_authorization_code IS DISTINCT FROM v_new.token`
    // → matched every plan (NULL is distinct from any token) → fabricated
    // count. Confirm 0079 does not carry that predicate, and 0040 did.
    expect(MIG).not.toMatch(/paystack_authorization_code IS DISTINCT FROM/);
    expect(MIG40).toMatch(/paystack_authorization_code IS DISTINCT FROM v_new\.token/);
  });

  it('guards against a null / unchanged old-or-new token (no-op, no accidental NULL write)', () => {
    expect(MIG).toMatch(/IF\s+v_old\.token\s+IS NOT NULL\s+AND\s+v_new\.token\s+IS NOT NULL\s+AND\s+v_old\.token\s+IS DISTINCT FROM\s+v_new\.token\s+THEN/);
  });

  it('still restricts to active / pending_first_payment plans (no historic overwrite)', () => {
    expect(MIG).toMatch(/status IN \('active', 'pending_first_payment'\)/);
  });
});

describe('0079 — repointed_plans count is truthful', () => {
  it('v_count increments ONLY inside the token-scoped RETURNING loop', () => {
    // The count is derived from rows actually UPDATEd (RETURNING id), so
    // the returned repointed_plans equals the real number of plans moved.
    expect(MIG).toMatch(/UPDATE plans\s+SET peach_registration_id[\s\S]*?RETURNING id, invoice_number\s*LOOP[\s\S]*?v_count\s*:=\s*v_count\s*\+\s*1/);
    expect(MIG).toMatch(/'repointed_plans',\s*v_count/);
  });
});

describe('0079 — unchanged surface', () => {
  it('still flips is_default off the old card and onto the new one', () => {
    expect(MIG).toMatch(/UPDATE payment_methods\s+SET is_default = false\s+WHERE patient_id = v_user_id\s+AND is_default = true/);
    expect(MIG).toMatch(/UPDATE payment_methods\s+SET is_default = true\s+WHERE id = p_card_id/);
  });

  it('early-returns changed=false when the card is already default', () => {
    expect(MIG).toMatch(/IF v_new\.is_default THEN[\s\S]*?'changed',\s*false/);
  });

  it('inserts a collection_card_changed plan_event with from/to last_four per repointed plan', () => {
    expect(MIG).toMatch(/INSERT INTO plan_events[\s\S]{0,220}'collection_card_changed'/);
    expect(MIG).toMatch(/'from_last_four',\s*COALESCE\(v_old\.last_four, 'unknown'\)/);
    expect(MIG).toMatch(/'to_last_four',\s*v_new\.last_four/);
  });

  it('return payload keeps { changed, repointed_plans, plan_refs, old_last_four, new_last_four }', () => {
    expect(MIG).toMatch(/'changed',\s*true/);
    expect(MIG).toMatch(/'plan_refs',\s*v_refs/);
    expect(MIG).toMatch(/'old_last_four',\s*v_old\.last_four/);
    expect(MIG).toMatch(/'new_last_four',\s*v_new\.last_four/);
  });

  it('grants EXECUTE to authenticated (unchanged)', () => {
    expect(MIG).toMatch(/GRANT EXECUTE ON FUNCTION change_default_card\(uuid\)\s*TO authenticated/);
  });
});

describe('callers still invoke the RPC unchanged', () => {
  const HELPER = read('lib/changeDefaultCard.ts');
  it('callChangeDefaultCardRpc calls supabase.rpc(\'change_default_card\', { p_card_id })', () => {
    expect(HELPER).toMatch(/rpc\(\s*['"]change_default_card['"]\s*,\s*\{\s*p_card_id:\s*cardId\s*\}/);
    // The consumed result keys still match the RPC's return shape.
    expect(HELPER).toMatch(/result\.repointed_plans/);
    expect(HELPER).toMatch(/result\.old_last_four/);
    expect(HELPER).toMatch(/result\.new_last_four/);
  });
});
