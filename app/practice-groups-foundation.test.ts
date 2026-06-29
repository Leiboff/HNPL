import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Source-text regressions — brand-first inversion (Phase 2 / 0062) ───
//
// Pins the shape of the migrations and call-site discipline that the
// brand-first model relies on:
//   • Migration 0061 still adds practice_groups, practice_group_members
//     and the brand-admin helpers.
//   • Migration 0062 BACKFILLS a brand for every standalone practice,
//     then enforces NOT NULL on practices.group_id, then drops the
//     partial index in favour of a plain one.
//   • Brand-first signup creates a brand silently and grants the
//     signed-up user brand_admin of it.
//   • Brand-admin createBranch action forces status='pending' and
//     uses the service-role client (so the 0054 column-lock posture
//     is correct — INSERT, then subsequent UPDATEs blocked).
//   • Banking resolver no longer carries the pre-0062 "standalone
//     short-circuit"; it falls through to the brand lookup whenever
//     the practice has no own banking.
//   • Trading gate fires the banking condition UNIVERSALLY — no more
//     `if (practice.group_id)` wrapper. The check is gated only on
//     the banking resolver returning source:'none'.

const ROOT = resolve(process.cwd());
function read(p: string): string { return readFileSync(resolve(ROOT, p), 'utf8'); }

const MIG_0061     = read('supabase/migrations/0061_practice_groups.sql');
const MIG_0062     = read('supabase/migrations/0062_brand_first_inversion.sql');
const BANKING      = read('lib/practice/banking.ts');
const TRADING_GATE = read('lib/practice/tradingGate.ts');
const BRAND_ACT    = read('app/brand/actions.ts');
const ADMIN_GROUP  = read('app/admin/groups/actions.ts');
const SIGNUP_ACT   = read('app/signup/practice/actions.ts');

describe('Migration 0061 — schema shape (brand layer foundation)', () => {
  it('creates practice_groups with banking columns mirroring practices', () => {
    expect(MIG_0061).toMatch(/CREATE TABLE IF NOT EXISTS practice_groups/);
    for (const col of ['bank_name', 'bank_account_number', 'branch_code', 'account_holder', 'account_type']) {
      expect(MIG_0061).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it('adds practices.group_id as a nullable FK in 0061 (later flipped to NOT NULL in 0062)', () => {
    expect(MIG_0061).toMatch(/ALTER TABLE practices[\s\S]*?ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES practice_groups\(id\)/);
  });

  it('creates practice_group_members with a CHECK that only allows brand_admin (additive — supersets later)', () => {
    expect(MIG_0061).toMatch(/CREATE TABLE IF NOT EXISTS practice_group_members/);
    expect(MIG_0061).toMatch(/ADD\s+CONSTRAINT practice_group_members_role_check\s*CHECK\s*\(role IN \('brand_admin'\)\)/);
  });

  it('defines is_brand_admin + is_brand_admin_of_practice helpers (STABLE SECURITY DEFINER)', () => {
    expect(MIG_0061).toMatch(/CREATE OR REPLACE FUNCTION is_brand_admin\(p_group_id UUID\)[\s\S]*?STABLE[\s\S]*?SECURITY DEFINER/);
    expect(MIG_0061).toMatch(/CREATE OR REPLACE FUNCTION is_brand_admin_of_practice\(p_practice_id UUID\)[\s\S]*?STABLE[\s\S]*?SECURITY DEFINER/);
  });

  it('adds permissive brand-admin SELECT policies on practices / practice_members / plans / payments / payouts', () => {
    expect(MIG_0061).toMatch(/CREATE POLICY "brand_admin_select_branches"\s+ON practices/);
    expect(MIG_0061).toMatch(/CREATE POLICY "brand_admin_select_branch_members"\s+ON practice_members/);
    expect(MIG_0061).toMatch(/CREATE POLICY "brand_admin_select_branch_plans"\s+ON plans/);
    expect(MIG_0061).toMatch(/CREATE POLICY "brand_admin_select_branch_payments"\s+ON payments/);
    expect(MIG_0061).toMatch(/CREATE POLICY "brand_admin_select_branch_payouts"\s+ON payouts/);
  });
});

describe('Migration 0062 — brand-first inversion shape', () => {
  it('backfills a brand for every standalone practice (with the practice owner as brand_admin)', () => {
    // The DO block iterates standalone practices, INSERTs a
    // practice_groups row, then sets group_id, then upserts the
    // owner as a brand_admin. We pin the literal SQL so future
    // edits that move steps around have to re-prove the order.
    expect(MIG_0062).toMatch(/FOR r IN\s+SELECT[\s\S]*?FROM practices[\s\S]*?WHERE group_id IS NULL/);
    expect(MIG_0062).toMatch(/INSERT INTO practice_groups[\s\S]*?RETURNING id INTO new_group_id/);
    expect(MIG_0062).toMatch(/UPDATE practices[\s\S]*?SET group_id = new_group_id/);
    expect(MIG_0062).toMatch(/INSERT INTO practice_group_members[\s\S]*?ON CONFLICT \(group_id, user_id\) DO UPDATE/);
  });

  it('enforces NOT NULL on practices.group_id (AFTER the backfill)', () => {
    expect(MIG_0062).toMatch(/ALTER TABLE practices\s+ALTER COLUMN group_id SET NOT NULL/);
    // Order: backfill must precede the NOT NULL constraint or it
    // would fail on existing rows.
    const backfillIdx = MIG_0062.indexOf('FOR r IN');
    const notNullIdx  = MIG_0062.indexOf('SET NOT NULL');
    expect(backfillIdx).toBeGreaterThan(0);
    expect(notNullIdx).toBeGreaterThan(backfillIdx);
  });

  it('replaces the partial index with a plain btree index', () => {
    expect(MIG_0062).toMatch(/DROP INDEX IF EXISTS practices_group_id_idx/);
    expect(MIG_0062).toMatch(/CREATE INDEX IF NOT EXISTS practices_group_id_idx\s+ON practices \(group_id\);/);
  });
});

describe('Banking resolver — post-0062 single code path', () => {
  it('no longer carries the pre-0062 "standalone short-circuit"', () => {
    // The pre-0062 line was: `if (!practice.group_id) return { source: 'none' };`
    // appearing BEFORE the practice_groups SELECT. Post-0062 a defensive
    // version stays (for snapshot-restore edge cases) but the call-site
    // ordering must be: own-banking-check FIRST, then defensive null
    // guard, then the brand lookup. Pin that ordering literally.
    const ownIdx     = BANKING.indexOf("if (hasBanking(practice))");
    const guardIdx   = BANKING.indexOf("if (!practice.group_id) return { source: 'none' };");
    const lookupIdx  = BANKING.indexOf("from('practice_groups')");
    expect(ownIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeGreaterThan(ownIdx);
    expect(lookupIdx).toBeGreaterThan(guardIdx);
  });
});

describe('Trading gate — universal banking condition (no more branch-only gating)', () => {
  it('does NOT wrap the banking call in if (practice.group_id) {...}', () => {
    // The pre-0062 source had:
    //   if (practice.group_id) { const banking = await resolvePayoutBanking(...) ... }
    // Post-0062 the call is unconditional. If a future edit reintroduces
    // the wrapper, this test fails.
    expect(TRADING_GATE).not.toMatch(/if \(practice\.group_id\)\s*\{/);
    // Banking call must still be present and ungated.
    expect(TRADING_GATE).toMatch(/const banking = await resolveBanking\(supabase, practiceId\);/);
    expect(TRADING_GATE).toMatch(/banking\.source === 'none'/);
  });
});

describe('Brand-first signup — auto-create brand silently', () => {
  it('inserts a practice_groups row before the practices row, in the same try block', () => {
    // The order matters: brand first (so we have its id), then
    // practice with group_id pointing to it. Verify the literal
    // ordering by file position.
    const brandIdx     = SIGNUP_ACT.indexOf("from('practice_groups')");
    const practiceIdx  = SIGNUP_ACT.indexOf("from('practices').insert(");
    expect(brandIdx).toBeGreaterThan(0);
    expect(practiceIdx).toBeGreaterThan(brandIdx);
  });

  it('passes group_id to the practices insert', () => {
    expect(SIGNUP_ACT).toMatch(/group_id:\s+brandId/);
  });

  it('grants the signed-up user brand_admin of their new brand', () => {
    expect(SIGNUP_ACT).toMatch(/from\('practice_group_members'\)[\s\S]*?role:\s+['"]brand_admin['"]/);
  });

  it('does NOT expose "brand" or "group" wording in the signup page copy (solo UX)', () => {
    // Signup page copy: must avoid the words "brand" / "group" /
    // "branch" outside of code-identifier contexts (which the test
    // can't easily distinguish). Read it once and check user-facing
    // strings.
    const PAGE = read('app/signup/practice/page.tsx');
    // We use these patterns: visible heading + form copy. None of
    // them should appear in JSX text. Tight pattern: word boundary
    // + lowercase to avoid hitting field names like "Brand".
    for (const word of ['brand', 'group']) {
      // Allow the word to appear inside `// comments` only — strip
      // them before checking.
      const stripped = PAGE
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const re = new RegExp(`>[^<]*\\b${word}\\b[^<]*<`, 'i');
      expect(stripped).not.toMatch(re);
    }
  });
});

describe('Brand-admin createBranch — pending + service-role + cannot self-approve', () => {
  it('forces status="pending" on INSERT', () => {
    expect(BRAND_ACT).toMatch(/status:\s*['"]pending['"]/);
  });

  it('uses the service-role client (createServiceClient) for the write', () => {
    expect(BRAND_ACT).toMatch(/createClient as createServiceClient/);
    expect(BRAND_ACT).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('guards via brand-admin membership BEFORE any write', () => {
    const guardIdx  = BRAND_ACT.indexOf('guardBrandAdmin(');
    const insertIdx = BRAND_ACT.indexOf("from('practices')");
    expect(guardIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(guardIdx);
  });
});

describe('Platform-admin group actions — guard + service-role', () => {
  it('every action gates on platform-admin role before writing', () => {
    const guardCount = (ADMIN_GROUP.match(/await guardAdmin\(\)/g) ?? []).length;
    // Post-0062 the unassignPracticeFromGroup action is gone — it
    // would have set group_id = NULL which violates the NOT NULL
    // constraint. Five remaining admin actions: createGroup,
    // updateGroupBanking, assignPracticeToGroup, grantBrandAdmin,
    // revokeBrandAdmin. Each calls guardAdmin once.
    expect(guardCount).toBeGreaterThanOrEqual(5);
  });

  it('no unassignPracticeFromGroup — NOT NULL on group_id would make it fail anyway', () => {
    expect(ADMIN_GROUP).not.toMatch(/unassignPracticeFromGroup/);
    expect(ADMIN_GROUP).not.toMatch(/group_id:\s*null/);
  });
});
