import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ─── Source-text regressions — practice discovery via the view ──────────
//
// Migration 0063 introduces `practices_directory`, a definer view that
// exposes ONLY the patient-discovery-safe columns from `practices` and
// hard-filters to status = 'approved'. The patient explore page is
// repointed at the view; internal flows continue to query the table.
//
// These tests pin:
//   (a) the migration shape (security_invoker = false, the GRANT/REVOKE
//       posture, the approved-only filter, the safe-column allowlist),
//   (b) the absence of sensitive columns from the view definition (a
//       column whitelist — adding a sensitive column to `practices`
//       later cannot accidentally leak through this view),
//   (c) the explore page queries `practices_directory`, not the
//       `practices` table, and
//   (d) no other file in `app/` uses the view — keeping the surface
//       minimal so future code can't silently widen patient access.

const ROOT = resolve(process.cwd());
function read(p: string): string { return readFileSync(resolve(ROOT, p), 'utf8'); }

const MIG_0063   = read('supabase/migrations/0063_practices_directory_view.sql');
const EXPLORE    = read('app/patient/explore/page.tsx');

// ─── Sensitive column list ─────────────────────────────────────────────
//
// Every column on `practices` that a patient must NOT be able to read
// at discovery. If a future migration adds a sensitive column, add it
// to this list and the "view excludes" assertion below will fail until
// someone has thought about it.
const SENSITIVE_COLUMNS = [
  'fee_percent',
  'bank_name',
  'bank_account_number',
  'branch_code',
  'account_holder',
  'account_type',
  'owner_id',
  'approved_by',
  'approved_at',
  'created_at',
  'group_id',
  'admin_email',
  'admin_is_provider',
  'admin_specialty',
  'admin_hpcsa_number',
  'address_line1',
  'address_line2',
  'postal_code',
  'hpcsa_number',
  'practice_registration_number',
];

// ─── Tests ─────────────────────────────────────────────────────────────

describe('Migration 0063 — view shape', () => {
  it('creates a view named practices_directory', () => {
    expect(MIG_0063).toMatch(/CREATE OR REPLACE VIEW practices_directory/);
  });

  it('runs with security_invoker = false (definer) so RLS on the base table is bypassed', () => {
    // Without this, the base table's relationship-scoped policies would
    // re-block the patient — discovery would be no better than today.
    expect(MIG_0063).toMatch(/WITH \(security_invoker = false\)/);
  });

  it('hard-filters to status = approved (no pending/suspended/inactive practices leak)', () => {
    expect(MIG_0063).toMatch(/WHERE status = 'approved'/);
  });

  it('GRANTs SELECT to authenticated only — anon and PUBLIC are explicitly revoked', () => {
    // Order matters: REVOKE first so re-runs don't accumulate stale
    // grants, THEN grant authenticated. Match the actual SQL
    // statement (terminating semicolon) to avoid hitting the same
    // phrase inside the header comment.
    const revokePublicIdx = MIG_0063.indexOf('REVOKE ALL ON practices_directory FROM PUBLIC;');
    const revokeAnonIdx   = MIG_0063.indexOf('REVOKE ALL ON practices_directory FROM anon;');
    const grantAuthIdx    = MIG_0063.indexOf('GRANT SELECT ON practices_directory TO authenticated;');
    expect(revokePublicIdx).toBeGreaterThan(0);
    expect(revokeAnonIdx).toBeGreaterThan(0);
    expect(grantAuthIdx).toBeGreaterThan(0);
    expect(grantAuthIdx).toBeGreaterThan(revokePublicIdx);
    expect(grantAuthIdx).toBeGreaterThan(revokeAnonIdx);
  });
});

describe('Migration 0063 — column allowlist (the safety property)', () => {
  // Extract the SELECT list of the view by slicing between
  // `CREATE OR REPLACE VIEW … AS` and the `FROM practices` line.
  // Tightly scoped so other SQL text in the file (comments,
  // COMMENT ON, GRANT clauses) can't accidentally satisfy the
  // assertions below.
  const selectBlockMatch = MIG_0063.match(/AS[\s\S]*?SELECT([\s\S]*?)FROM practices/);
  const selectList = (selectBlockMatch?.[1] ?? '').toLowerCase();

  it('select-list extraction works (sanity check)', () => {
    expect(selectList).not.toBe('');
  });

  const SAFE_COLUMNS = [
    'id', 'name', 'specialty',
    'suburb', 'city', 'practice_province',
    'latitude', 'longitude',
    'phone', 'email',
  ];

  it.each(SAFE_COLUMNS)('view exposes safe column: %s', (col) => {
    expect(selectList).toMatch(new RegExp(`\\b${col}\\b`));
  });

  it.each(SENSITIVE_COLUMNS)('view does NOT expose sensitive column: %s', (col) => {
    expect(selectList).not.toMatch(new RegExp(`\\b${col}\\b`));
  });
});

describe('Explore page is repointed at the view, not the table', () => {
  it('queries practices_directory (not the practices table)', () => {
    expect(EXPLORE).toMatch(/from\('practices_directory'\)/);
    // Belt-and-braces: no remaining .from('practices') in this file.
    expect(EXPLORE).not.toMatch(/from\('practices'\)/);
  });

  it('does NOT re-apply a status filter — the view is approved-only by construction', () => {
    expect(EXPLORE).not.toMatch(/\.eq\('status'/);
  });
});

describe('practices_directory is used ONLY by the patient explore page', () => {
  // Walk app/ + lib/ and check that no other source file references
  // the view. Internal flows (admin, practice dashboard, billing,
  // trading gate, banking resolver) must continue to query the
  // `practices` table directly — they need columns the view doesn't
  // expose and operate under their own RLS context. If anything else
  // starts touching the view, this test flags it for review.
  const allowed = new Set([
    resolve(ROOT, 'app/patient/explore/page.tsx').toLowerCase(),
    resolve(ROOT, 'app/patient/explore/directory-view.test.ts').toLowerCase(),
    resolve(ROOT, 'supabase/migrations/0063_practices_directory_view.sql').toLowerCase(),
  ]);

  function walk(dir: string, hits: string[]) {
    for (const entry of readdirSync(dir) as string[]) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) { walk(full, hits); continue; }
      if (!/\.(ts|tsx|sql)$/.test(entry)) continue;
      const body = readFileSync(full, 'utf8');
      if (body.includes('practices_directory')) hits.push(full);
    }
  }

  it('only the explore page + migration reference practices_directory', () => {
    const hits: string[] = [];
    walk(resolve(ROOT, 'app'), hits);
    walk(resolve(ROOT, 'lib'), hits);
    walk(resolve(ROOT, 'supabase/migrations'), hits);
    const unexpected = hits.filter((p) => !allowed.has(p.toLowerCase()));
    expect(unexpected).toEqual([]);
  });
});

describe('Existing practices SELECT policies are NOT loosened (internal flows unchanged)', () => {
  // The fix is additive: the patient explore page goes through the
  // VIEW; the TABLE keeps its existing relationship-scoped policies
  // verbatim. This test pins those policies' presence — if a future
  // edit removes one, we want to know.
  const POL_0002 = read('supabase/migrations/0002_rls_policies.sql');
  const POL_0004 = read('supabase/migrations/0004_practice_owner_policies.sql');
  const POL_0008 = read('supabase/migrations/0008_patient_practice_select.sql');
  const POL_0061 = read('supabase/migrations/0061_practice_groups.sql');

  it('practice_members_select_own_practice still exists (0002)', () => {
    expect(POL_0002).toMatch(/CREATE POLICY "practice_members_select_own_practice" ON practices/);
  });
  it('admins_select_all_practices still exists (0002)', () => {
    expect(POL_0002).toMatch(/CREATE POLICY "admins_select_all_practices" ON practices/);
  });
  it('owners_select_own_practice still exists (0004)', () => {
    expect(POL_0004).toMatch(/CREATE POLICY "owners_select_own_practice" ON practices/);
  });
  it('patients_select_practice_for_own_plans still exists (0008)', () => {
    expect(POL_0008).toMatch(/CREATE POLICY "patients_select_practice_for_own_plans" ON practices/);
  });
  it('brand_admin_select_branches still exists (0061)', () => {
    expect(POL_0061).toMatch(/CREATE POLICY "brand_admin_select_branches"\s+ON practices/);
  });

  it('migration 0063 does NOT touch policies on the practices table', () => {
    // The view migration adds NO policies, drops NO policies, alters
    // NO policies. It only creates the view + grants on the view.
    expect(MIG_0063).not.toMatch(/CREATE POLICY/i);
    expect(MIG_0063).not.toMatch(/DROP POLICY/i);
    expect(MIG_0063).not.toMatch(/ALTER POLICY/i);
    expect(MIG_0063).not.toMatch(/ON practices\b/);  // word-boundary so "_directory" doesn't trip
  });
});
