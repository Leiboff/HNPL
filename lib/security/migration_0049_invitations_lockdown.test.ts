import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Migration 0049 — patient_invitations PII lockdown ─────────────────────
//
// Source-text regression on the migration file. The vulnerability:
// migration 0021's `public_token_lookup` policy used `USING (true)`,
// which let any caller with the anon key bulk-SELECT every invitation
// row (patient emails, tokens, practice/provider FKs).
//
// These tests assert the FIX is intact in the migration:
//   1. The wide-open policy is dropped.
//   2. A SECURITY DEFINER function replaces it.
//   3. The function filters to non-expired AND unaccepted invitations.
//   4. The function is exact-token-match only (no LIKE / no IN list).
//   5. Anon role has EXECUTE on the function (so the unauthenticated
//      checkout page can call it).
//   6. The migration does NOT re-create a wide-open SELECT policy.
//
// We cannot run SQL against a live database from vitest, so the
// runtime invariant "anon SELECT * on patient_invitations returns
// nothing" is verified by reading the migration's SQL text. A live-DB
// verification recipe is in the report alongside this fix.

const ROOT = resolve(process.cwd());
const migration = readFileSync(
  resolve(ROOT, 'supabase/migrations/0049_patient_invitations_lock_token_lookup.sql'),
  'utf8',
);

describe('migration 0049 — drops the wide-open SELECT policy', () => {
  it('contains a DROP POLICY for public_token_lookup', () => {
    expect(migration).toMatch(/DROP POLICY[^;]*public_token_lookup[^;]*ON\s+patient_invitations/i);
  });

  it('does NOT re-create any SELECT policy with USING(true) — that was the bug', () => {
    expect(migration).not.toMatch(/CREATE POLICY[^;]*USING\s*\(\s*true\s*\)/i);
  });
});

describe('migration 0049 — creates the exact-token lookup function', () => {
  it('defines get_invitation_by_token', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION\s+get_invitation_by_token\s*\(/);
  });

  it('marks the function SECURITY DEFINER (runs as owner, not caller)', () => {
    expect(migration).toMatch(/SECURITY\s+DEFINER/i);
  });

  it('pins search_path so caller-controlled schemas can\'t shadow public', () => {
    expect(migration).toMatch(/SET\s+search_path\s*=\s*public/i);
  });

  it('looks up the row by EXACT token equality — no LIKE, no IN', () => {
    expect(migration).toMatch(/WHERE\s+pi\.token\s*=\s*p_token/);
    expect(migration).not.toMatch(/pi\.token\s+LIKE/i);
    expect(migration).not.toMatch(/pi\.token\s+IN\s*\(/i);
  });

  it('filters to non-expired AND unaccepted invitations', () => {
    expect(migration).toMatch(/pi\.accepted_at\s+IS\s+NULL/i);
    expect(migration).toMatch(/pi\.expires_at\s*>\s*now\(\)/i);
  });

  it("filters out plans whose status makes the bill un-payable", () => {
    expect(migration).toMatch(/pl\.status\s+NOT\s+IN/i);
    expect(migration).toMatch(/'completed'/);
    expect(migration).toMatch(/'cancelled'/);
    expect(migration).toMatch(/'declined'/);
  });

  it('caps at one row (LIMIT 1) so the function can never leak a list', () => {
    expect(migration).toMatch(/LIMIT\s+1/i);
  });
});

describe('migration 0049 — grants', () => {
  it('grants EXECUTE on the function to anon (so the unauthenticated checkout page can call it)', () => {
    // Permissive match — allow optional schema-qualified function name, any whitespace.
    expect(migration).toMatch(/GRANT\s+EXECUTE[\s\S]*get_invitation_by_token[\s\S]*\banon\b/i);
  });

  it('grants EXECUTE to authenticated as well (logged-in patient revisiting a stale link)', () => {
    expect(migration).toMatch(/GRANT\s+EXECUTE[\s\S]*get_invitation_by_token[\s\S]*authenticated/i);
  });

  it('does NOT grant TABLE-level SELECT to anon (the original PII vector)', () => {
    // Defensive: a future "convenience" GRANT SELECT ON patient_invitations TO anon
    // would re-open the bulk-dump path. Catch it here.
    expect(migration).not.toMatch(/GRANT\s+SELECT[\s\S]*ON\s+patient_invitations[\s\S]*TO\s+anon/i);
  });
});

describe('migration 0049 — comment carries the rationale', () => {
  it('has a COMMENT ON FUNCTION explaining its replacement role', () => {
    expect(migration).toMatch(/COMMENT\s+ON\s+FUNCTION\s+get_invitation_by_token/i);
    expect(migration).toMatch(/[Rr]eplaces.*public_token_lookup/);
  });
});
