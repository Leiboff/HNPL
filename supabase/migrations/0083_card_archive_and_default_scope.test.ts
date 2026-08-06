import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Migration 0083 — card archive + default-scope invariants ────────────
//
// Source-text pins over the SQL so the two rules can't silently regress:
//   RULE 1  set_default_card_flag flips is_default and touches NO plan.
//   RULE 2  archive_card guards on active-plan collection, soft-deletes,
//           and the patient hard-DELETE policy is removed.

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0083_card_archive_and_default_scope.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('0083 — archived_at soft-delete column', () => {
  it('adds a nullable archived_at column idempotently', () => {
    expect(MIG).toMatch(/ALTER TABLE payment_methods\s+ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/);
  });
});

describe('0083 — RULE 1: set_default_card_flag is flag-only', () => {
  it('creates the function, SECURITY DEFINER, granted to authenticated', () => {
    expect(MIG).toMatch(/CREATE OR REPLACE FUNCTION set_default_card_flag\(p_card_id uuid\)/);
    expect(MIG).toMatch(/GRANT EXECUTE ON FUNCTION set_default_card_flag\(uuid\) TO authenticated/);
  });

  it('flips is_default and NEVER updates a plans row', () => {
    // Slice the function BODY only (up to its `$$;`), so the trailing
    // COMMENT — which legitimately mentions peach_registration_id — doesn't
    // trip the "no plan repoint" assertion.
    const start = MIG.indexOf('CREATE OR REPLACE FUNCTION set_default_card_flag');
    const body  = MIG.slice(start, MIG.indexOf('$$;', start));
    expect(body).toMatch(/SET is_default = true/);
    expect(body).toMatch(/SET is_default = false/);
    // The crux of RULE 1: no plan repoint here.
    expect(body).not.toMatch(/UPDATE plans/);
    expect(body).not.toMatch(/peach_registration_id/);
  });
});

describe('0083 — RULE 2: archive_card guards + soft-deletes', () => {
  const start = MIG.indexOf('FUNCTION archive_card');
  const body  = MIG.slice(start);

  it('blocks archiving while the card backs an active/pending plan', () => {
    expect(body).toMatch(/status IN \('active', 'pending_first_payment'\)/);
    expect(body).toMatch(/peach_registration_id = v_card\.token/);
    expect(body).toMatch(/RAISE EXCEPTION 'card_collecting_active_plan'/);
  });

  it('soft-deletes (sets archived_at) rather than DELETEing, and clears the default flag', () => {
    expect(body).toMatch(/SET archived_at = now\(\)/);
    expect(body).toMatch(/is_default  = false/);
    expect(body).not.toMatch(/DELETE FROM payment_methods/);
  });

  it('promotes the newest other active card when the default is archived', () => {
    expect(body).toMatch(/archived_at IS NULL/);
    expect(body).toMatch(/ORDER BY created_at DESC/);
  });
});

describe('0083 — hard-delete path removed so the guard can\'t be bypassed', () => {
  it('drops the patient DELETE RLS policy', () => {
    expect(MIG).toMatch(/DROP POLICY IF EXISTS patients_delete_own_payment_methods ON payment_methods/);
  });
});
