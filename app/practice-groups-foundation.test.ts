import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Source-text regressions — practice-groups foundation (Phase 1) ─────
//
// Pins the shape of migration 0061 and the call-site discipline that
// the brand layer relies on:
//   • Migration adds practice_groups, practices.group_id, and
//     practice_group_members idempotently with the right CHECK +
//     RLS shape.
//   • Brand-admin createBranch action forces status='pending' and
//     uses the service-role client (so the 0054 column-lock posture
//     is correct — INSERT, then subsequent UPDATEs blocked).
//   • Banking resolver does NOT issue a group lookup for standalone
//     practices (the short-circuit is the byte-for-byte unchanged
//     guarantee for the standalone path).
//   • Trading gate extension only fires for branches (group_id NOT NULL).

const ROOT = resolve(process.cwd());
function read(p: string): string { return readFileSync(resolve(ROOT, p), 'utf8'); }

const MIG_0061     = read('supabase/migrations/0061_practice_groups.sql');
const BANKING      = read('lib/practice/banking.ts');
const TRADING_GATE = read('lib/practice/tradingGate.ts');
const BRAND_ACT    = read('app/brand/actions.ts');
const ADMIN_GROUP  = read('app/admin/groups/actions.ts');

describe('Migration 0061 — schema shape', () => {
  it('creates practice_groups with banking columns mirroring practices', () => {
    expect(MIG_0061).toMatch(/CREATE TABLE IF NOT EXISTS practice_groups/);
    for (const col of ['bank_name', 'bank_account_number', 'branch_code', 'account_holder', 'account_type']) {
      expect(MIG_0061).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it('adds practices.group_id as a nullable FK with a partial index', () => {
    expect(MIG_0061).toMatch(/ALTER TABLE practices[\s\S]*?ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES practice_groups\(id\)/);
    expect(MIG_0061).toMatch(/CREATE INDEX IF NOT EXISTS practices_group_id_idx[\s\S]*?WHERE group_id IS NOT NULL/);
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
    // Each policy widens the existing per-practice access surface for
    // brand-admins — the existing policies stay in effect and remain
    // the entire access surface for STANDALONE practices.
    expect(MIG_0061).toMatch(/CREATE POLICY "brand_admin_select_branches"\s+ON practices/);
    expect(MIG_0061).toMatch(/CREATE POLICY "brand_admin_select_branch_members"\s+ON practice_members/);
    expect(MIG_0061).toMatch(/CREATE POLICY "brand_admin_select_branch_plans"\s+ON plans/);
    expect(MIG_0061).toMatch(/CREATE POLICY "brand_admin_select_branch_payments"\s+ON payments/);
    expect(MIG_0061).toMatch(/CREATE POLICY "brand_admin_select_branch_payouts"\s+ON payouts/);
  });

  it('is idempotent — IF NOT EXISTS / DROP CONSTRAINT IF EXISTS / DROP POLICY IF EXISTS throughout', () => {
    expect(MIG_0061).toMatch(/CREATE TABLE IF NOT EXISTS practice_groups/);
    expect(MIG_0061).toMatch(/CREATE TABLE IF NOT EXISTS practice_group_members/);
    expect(MIG_0061).toMatch(/ADD COLUMN IF NOT EXISTS group_id/);
    expect(MIG_0061).toMatch(/DROP CONSTRAINT IF EXISTS practice_groups_status_check/);
    expect(MIG_0061).toMatch(/DROP POLICY IF EXISTS "platform_admin_all_practice_groups"/);
  });
});

describe('Banking resolver — standalone short-circuit', () => {
  it('the resolver returns source:none BEFORE issuing the group lookup when group_id is null', () => {
    // The short-circuit is the byte-for-byte unchanged guarantee for
    // standalone practices. If a future edit moves the group SELECT
    // before the !practice.group_id return, this test fails.
    const standaloneBlock = BANKING.match(/Standalone[\s\S]*?if \(!practice\.group_id\) return \{ source: 'none' \};/);
    expect(standaloneBlock).not.toBeNull();
    // And the practice_groups SELECT must appear AFTER the short-circuit.
    const ngIdx     = BANKING.indexOf("if (!practice.group_id) return { source: 'none' };");
    const groupIdx  = BANKING.indexOf("from('practice_groups')");
    expect(ngIdx).toBeGreaterThan(0);
    expect(groupIdx).toBeGreaterThan(ngIdx);
  });
});

describe('Trading gate — banking condition fires for BRANCHES ONLY', () => {
  it('the no_banking branch is gated on practice.group_id (standalone untouched)', () => {
    expect(TRADING_GATE).toMatch(/if \(practice\.group_id\)[\s\S]*?resolvePayoutBanking[\s\S]*?source === 'none'[\s\S]*?'no_banking'/);
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
    // guardBrandAdmin must be called before svc().from('practices').insert
    const guardIdx  = BRAND_ACT.indexOf('guardBrandAdmin(');
    const insertIdx = BRAND_ACT.indexOf("from('practices')");
    expect(guardIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(guardIdx);
  });
});

describe('Platform-admin group actions — guard + service-role', () => {
  it('every action gates on platform-admin role before writing', () => {
    // Each exported async function calls guardAdmin() in its first
    // statement; check the presence of guardAdmin BEFORE any svc()
    // .from('practice_groups')/practice_group_members write site.
    const guardCount = (ADMIN_GROUP.match(/await guardAdmin\(\)/g) ?? []).length;
    // Five admin actions: createGroup, updateGroupBanking,
    // assignPracticeToGroup, unassignPracticeFromGroup, grantBrandAdmin,
    // revokeBrandAdmin. Each calls guardAdmin once.
    expect(guardCount).toBeGreaterThanOrEqual(6);
  });
});
