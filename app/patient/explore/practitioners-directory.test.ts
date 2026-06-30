import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ─── Source-text regressions — practitioner discovery view (0064) ─────
//
// Migration 0064 introduces `practitioners_directory`, a definer view
// over (practice_members JOIN profiles JOIN practices) that:
//   • exposes ONLY directory-safe columns (no banking, no fee_percent,
//     no personal_*, no sa_id_number, no raw HPCSA, no internal FKs)
//   • hard-filters to role='provider' + active=TRUE + practices.status='approved'
//   • hashes HPCSA (md5) for client-side grouping; exposes a boolean
//     "registered" badge
//   • is GRANT SELECT TO authenticated; REVOKEd from anon and PUBLIC
//
// These tests pin:
//   (a) the migration shape (security_invoker = false, GRANT/REVOKE),
//   (b) the safe-column allowlist + sensitive-column exclusion (the
//       same adversarial discipline used for 0063),
//   (c) the WHERE clause filters (role/active/approved),
//   (d) the explore page queries the view, not the base tables,
//   (e) single-callsite invariant — only the explore page + helper +
//       migration + this test reference the view name.

const ROOT = resolve(process.cwd());
function read(p: string): string { return readFileSync(resolve(ROOT, p), 'utf8'); }

const MIG_0064 = read('supabase/migrations/0064_practitioners_directory_view.sql');
const PAGE     = read('app/patient/explore/page.tsx');

// ─── Sensitive column inventory ────────────────────────────────────────
//
// Every column on practice_members / profiles / practices that a
// patient must NOT be able to read at discovery. Adding a sensitive
// column to any of those tables later → add it here, and the
// "view excludes" assertion will fail until someone has thought
// about it.
const SENSITIVE_COLUMNS = [
  // practice_members financial / internal
  'personal_bank_name',
  'personal_account_holder',
  'personal_account_number',
  'personal_branch_code',
  'personal_account_type',
  'payout_destination',
  'can_create_bills',
  'can_manage_practice',
  'sa_id_number',
  // practices financial / internal
  'fee_percent',
  'bank_name',
  'bank_account_number',
  'branch_code',
  'account_holder',
  'account_type',
  'owner_id',
  'approved_by',
  'approved_at',
  'group_id',
  'address_line1',
  'address_line2',
  'postal_code',
  'practice_registration_number',
  'admin_email',
  'admin_is_provider',
  'admin_specialty',
  'admin_hpcsa_number',
];

// HPCSA is special: the RAW column name `hpcsa_number` MUST NOT appear
// in the view's SELECT list (we expose md5 hash + boolean instead).
// We assert this separately because the substring is partially shared
// with `hpcsa_group_key` and `hpcsa_registered`.

describe('Migration 0064 — view shape', () => {
  it('creates a view named practitioners_directory', () => {
    expect(MIG_0064).toMatch(/CREATE OR REPLACE VIEW practitioners_directory/);
  });

  it('runs with security_invoker = false (definer)', () => {
    expect(MIG_0064).toMatch(/WITH \(security_invoker = false\)/);
  });

  it('filters to role=provider AND active=TRUE AND practices.status=approved', () => {
    expect(MIG_0064).toMatch(/WHERE pm\.role\s*=\s*'provider'/);
    expect(MIG_0064).toMatch(/AND\s+pm\.active\s*=\s*TRUE/);
    expect(MIG_0064).toMatch(/AND\s+practices\.status\s*=\s*'approved'/);
  });

  it('GRANTs SELECT to authenticated; REVOKEs PUBLIC and anon (order: revoke before grant)', () => {
    const revokePublicIdx = MIG_0064.indexOf('REVOKE ALL ON practitioners_directory FROM PUBLIC;');
    const revokeAnonIdx   = MIG_0064.indexOf('REVOKE ALL ON practitioners_directory FROM anon;');
    const grantAuthIdx    = MIG_0064.indexOf('GRANT SELECT ON practitioners_directory TO authenticated;');
    expect(revokePublicIdx).toBeGreaterThan(0);
    expect(revokeAnonIdx).toBeGreaterThan(0);
    expect(grantAuthIdx).toBeGreaterThan(0);
    expect(grantAuthIdx).toBeGreaterThan(revokePublicIdx);
    expect(grantAuthIdx).toBeGreaterThan(revokeAnonIdx);
  });
});

// Extract the SELECT list once, with SQL comments stripped — the
// inline `-- safe bits — no email, no phone, no SA-ID` style comments
// would otherwise leak the words "email"/"phone"/etc. into the
// regex tests below and produce false positives.
function extractSelectList(sql: string): string {
  const m = sql.match(/AS\s+SELECT([\s\S]*?)FROM practice_members/);
  const body = m?.[1] ?? '';
  // Strip `-- ...` line comments. SQL doesn't support /* */ inside
  // simple SELECT lists for our purposes; if we ever introduce them,
  // extend this stripper.
  return body.replace(/--[^\n]*/g, '').toLowerCase();
}
const selectList = extractSelectList(MIG_0064);

describe('Migration 0064 — HPCSA exposure: hash + boolean only (no raw number)', () => {

  it('the SELECT list extraction works (sanity check)', () => {
    expect(selectList).not.toBe('');
    // The stripper removed line comments — assert one of the SQL
    // identifiers we expect IS present (positive control).
    expect(selectList).toMatch(/\bhpcsa_group_key\b/);
  });

  it('exposes the hashed group key (md5)', () => {
    expect(MIG_0064).toMatch(/md5\(LOWER\(TRIM\(pm\.hpcsa_number\)\)\)/);
    expect(selectList).toMatch(/\bhpcsa_group_key\b/);
  });

  it('exposes the boolean "registered" badge', () => {
    expect(selectList).toMatch(/\bhpcsa_registered\b/);
  });

  it('does NOT expose the raw hpcsa_number column to the client (only inside the md5/IS NOT NULL expressions)', () => {
    // The raw column name DOES appear in the view source (inside the
    // CASE/md5 expressions). The thing that must NOT appear is an
    // unaliased `pm.hpcsa_number` or bare `hpcsa_number` SELECT-LIST
    // entry — i.e. as a comma-separated column item. We probe for
    // that pattern explicitly.
    const selectListClean = selectList
      .replace(/--[^\n]*/g, '')               // strip line comments
      .replace(/case[\s\S]*?end/g, 'CASE')    // strip CASE expressions
      .replace(/\([^)]*\)/g, '');             // strip parenthesised exprs

    // After stripping CASE + parens, a leaked raw column would appear
    // as `, hpcsa_number,` or similar. Assert it doesn't.
    expect(selectListClean).not.toMatch(/[,\s]hpcsa_number[\s,]/);
    expect(selectListClean).not.toMatch(/[,\s]pm\.hpcsa_number[\s,]/);
  });
});

describe('Migration 0064 — sensitive columns NOT in the SELECT list', () => {
  it.each(SENSITIVE_COLUMNS)('view does NOT expose sensitive column: %s', (col) => {
    expect(selectList).not.toMatch(new RegExp(`\\b${col}\\b`));
  });

  it('view does NOT expose profiles.email (practitioner personal email)', () => {
    // The PRACTICE.phone is exposed (the office line), and the
    // PRACTICE has no email column on the directory view either —
    // but the join hits profiles, so we must ensure no profile email
    // sneaks through.
    expect(selectList).not.toMatch(/\bemail\b/);
  });

  it('view does NOT expose profiles.phone (practitioner personal phone)', () => {
    // Only the PRACTICE phone is in the view (aliased as
    // `practice_phone`). The bare `phone` token would indicate a
    // profile-phone leak.
    expect(selectList).not.toMatch(/\bprofiles\.phone\b/);
    expect(selectList).not.toMatch(/\bp\.phone\b/);
  });
});

describe('Migration 0064 — safe columns ARE in the SELECT list', () => {
  const SAFE_COLUMNS = [
    'member_id',
    'hpcsa_group_key',
    'hpcsa_registered',
    'first_name',
    'last_name',
    'specialty',
    'practice_id',
    'practice_name',
    'practice_suburb',
    'practice_city',
    'practice_latitude',
    'practice_longitude',
    'practice_phone',
  ];

  it.each(SAFE_COLUMNS)('view exposes safe column: %s', (col) => {
    expect(selectList).toMatch(new RegExp(`\\b${col}\\b`));
  });
});

describe('Explore page is repointed at the practitioner view', () => {
  it('queries practitioners_directory (not practice_members / practices directly)', () => {
    expect(PAGE).toMatch(/from\('practitioners_directory'\)/);
    expect(PAGE).not.toMatch(/from\('practice_members'\)/);
    expect(PAGE).not.toMatch(/from\('practices'\)/);
  });

  it('does NOT re-apply role/active/status filters (the view enforces them)', () => {
    expect(PAGE).not.toMatch(/\.eq\(['"]role['"]/);
    expect(PAGE).not.toMatch(/\.eq\(['"]active['"]/);
    expect(PAGE).not.toMatch(/\.eq\(['"]status['"]/);
  });
});

describe('practitioners_directory is used ONLY by the patient explore page', () => {
  const allowed = new Set([
    resolve(ROOT, 'app/patient/explore/page.tsx').toLowerCase(),
    resolve(ROOT, 'app/patient/explore/practitioners-directory.test.ts').toLowerCase(),
    // The pure grouping helper documents the view name in its module
    // header (it's the data source for groupIntoCards etc.).
    resolve(ROOT, 'lib/practitioner/grouping.ts').toLowerCase(),
    resolve(ROOT, 'supabase/migrations/0064_practitioners_directory_view.sql').toLowerCase(),
  ]);

  function walk(dir: string, hits: string[]) {
    for (const entry of readdirSync(dir) as string[]) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) { walk(full, hits); continue; }
      if (!/\.(ts|tsx|sql)$/.test(entry)) continue;
      const body = readFileSync(full, 'utf8');
      if (body.includes('practitioners_directory')) hits.push(full);
    }
  }

  it('only the explore page + migration + this test reference practitioners_directory', () => {
    const hits: string[] = [];
    walk(resolve(ROOT, 'app'), hits);
    walk(resolve(ROOT, 'lib'), hits);
    walk(resolve(ROOT, 'supabase/migrations'), hits);
    const unexpected = hits.filter((p) => !allowed.has(p.toLowerCase()));
    expect(unexpected).toEqual([]);
  });
});

describe('Existing practice_members + practices SELECT policies are NOT loosened', () => {
  // The fix is additive: the explore page goes through the VIEW;
  // base tables keep their existing relationship-scoped policies
  // verbatim. We pin five of the canonical ones.
  const POL_0002 = read('supabase/migrations/0002_rls_policies.sql');
  const POL_0004 = read('supabase/migrations/0004_practice_owner_policies.sql');
  const POL_0008 = read('supabase/migrations/0008_patient_practice_select.sql');
  const POL_0061 = read('supabase/migrations/0061_practice_groups.sql');

  it('practice_members SELECT policies still exist (0002)', () => {
    expect(POL_0002).toMatch(/CREATE POLICY "members_select_own_membership" ON practice_members/);
    expect(POL_0002).toMatch(/CREATE POLICY "practice_admins_select_members" ON practice_members/);
  });
  it('practices SELECT policies still exist (0002 / 0004 / 0008 / 0061)', () => {
    expect(POL_0002).toMatch(/CREATE POLICY "practice_members_select_own_practice" ON practices/);
    expect(POL_0002).toMatch(/CREATE POLICY "admins_select_all_practices" ON practices/);
    expect(POL_0004).toMatch(/CREATE POLICY "owners_select_own_practice" ON practices/);
    expect(POL_0008).toMatch(/CREATE POLICY "patients_select_practice_for_own_plans" ON practices/);
    expect(POL_0061).toMatch(/CREATE POLICY "brand_admin_select_branches"\s+ON practices/);
  });

  it('migration 0064 introduces NO policies, ALTERs no tables', () => {
    expect(MIG_0064).not.toMatch(/CREATE POLICY/i);
    expect(MIG_0064).not.toMatch(/DROP POLICY/i);
    expect(MIG_0064).not.toMatch(/ALTER POLICY/i);
    expect(MIG_0064).not.toMatch(/ALTER TABLE/i);
  });
});
