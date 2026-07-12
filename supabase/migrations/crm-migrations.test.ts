import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Source-pin tests for the CRM Phase 1 migrations ─────────────────
//
// Regex-based structural invariants over the SQL. We can't hit a live
// database from unit tests, so these pins verify the migrations are
// shaped the way the app expects. Any refactor that drops a policy,
// weakens the CHECK constraint, or removes the auto-onboarded trigger
// trips these tests.

const ROOT = resolve(process.cwd());
function read(p: string): string { return readFileSync(resolve(ROOT, p), 'utf8'); }

describe('0067 — sales role addition', () => {
  const SRC = read('supabase/migrations/0067_sales_role.sql');

  it('adds "sales" to profiles_role_check', () => {
    expect(SRC).toMatch(/profiles_role_check/);
    expect(SRC).toMatch(/CHECK\s*\(\s*role\s+IN[\s\S]*?['"]sales['"]/i);
  });

  it('preserves the pre-existing five roles', () => {
    for (const role of ['patient', 'practice_admin', 'practice_provider', 'practice_staff', 'admin']) {
      expect(SRC).toMatch(new RegExp(`['"]${role}['"]`));
    }
  });
});

describe('0068 — practice_invitations', () => {
  const SRC = read('supabase/migrations/0068_practice_invitations.sql');

  it('creates the practice_invitations table + core columns', () => {
    expect(SRC).toMatch(/CREATE TABLE IF NOT EXISTS practice_invitations/);
    for (const col of ['email', 'practice_name', 'token', 'expires_at', 'accepted_at', 'accepted_by_practice_id', 'lead_id']) {
      expect(SRC).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it('enables RLS + admin/sales-only SELECT/INSERT/UPDATE policies', () => {
    expect(SRC).toMatch(/ALTER TABLE practice_invitations ENABLE ROW LEVEL SECURITY/);
    // Admin OR sales — nobody else.
    expect(SRC).toMatch(/practice_invitations_admin_sales_select[\s\S]*?IN\s*\(\s*'admin'\s*,\s*'sales'\s*\)/);
    expect(SRC).toMatch(/practice_invitations_admin_sales_insert/);
    expect(SRC).toMatch(/practice_invitations_admin_sales_update/);
  });

  it('provides an anonymous-safe token-lookup RPC that filters expired + accepted', () => {
    expect(SRC).toMatch(/CREATE OR REPLACE FUNCTION get_practice_invitation_by_token/);
    expect(SRC).toMatch(/SECURITY DEFINER/);
    expect(SRC).toMatch(/accepted_at\s+IS\s+NULL/);
    expect(SRC).toMatch(/expires_at\s+>\s+now\(\)/);
    expect(SRC).toMatch(/GRANT EXECUTE ON FUNCTION get_practice_invitation_by_token\(TEXT\) TO anon, authenticated/);
  });

  it('provides an accept_practice_invitation RPC keyed by token+practice', () => {
    expect(SRC).toMatch(/CREATE OR REPLACE FUNCTION accept_practice_invitation/);
    expect(SRC).toMatch(/p_practice_id/);
  });
});

describe('0069 — crm_leads + crm_activities', () => {
  const SRC = read('supabase/migrations/0069_crm_leads_and_activities.sql');

  it('creates crm_leads with pipeline enums (stage + source)', () => {
    expect(SRC).toMatch(/CREATE TABLE IF NOT EXISTS crm_leads/);
    // Stage enum values
    for (const s of ['new', 'contacted', 'meeting_scheduled', 'demo_done', 'agreement_sent', 'signed', 'onboarded', 'lost']) {
      expect(SRC).toMatch(new RegExp(`['"]${s}['"]`));
    }
    // Source enum values
    for (const s of ['referral', 'cold_outreach', 'inbound', 'event', 'other']) {
      expect(SRC).toMatch(new RegExp(`['"]${s}['"]`));
    }
  });

  it('creates crm_activities linked to crm_leads with ON DELETE CASCADE', () => {
    expect(SRC).toMatch(/CREATE TABLE IF NOT EXISTS crm_activities/);
    expect(SRC).toMatch(/lead_id[\s\S]*?REFERENCES crm_leads\(id\)\s+ON DELETE CASCADE/i);
  });

  it('enables RLS on both tables + admin/sales-only policies (SELECT/INSERT/UPDATE/DELETE)', () => {
    expect(SRC).toMatch(/ALTER TABLE crm_leads\s+ENABLE ROW LEVEL SECURITY/);
    expect(SRC).toMatch(/ALTER TABLE crm_activities\s+ENABLE ROW LEVEL SECURITY/);
    // At least SELECT + INSERT + UPDATE + DELETE policies on both tables,
    // each keyed on role IN ('admin', 'sales').
    for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(SRC).toMatch(new RegExp(`crm_leads_admin_sales_${op.toLowerCase()}`));
      expect(SRC).toMatch(new RegExp(`crm_activities_admin_sales_${op.toLowerCase()}`));
    }
    // The scope check happens via profiles.role IN ('admin', 'sales')
    const matches = SRC.match(/IN\s*\(\s*'admin'\s*,\s*'sales'\s*\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(8);
  });

  it('enforces stage="lost" requires a non-empty lost_reason (BEFORE UPDATE trigger + CHECK)', () => {
    expect(SRC).toMatch(/crm_leads_stage_change/);
    expect(SRC).toMatch(/lost_reason\s+is\s+required/i);
    // CHECK constraint for INSERT-time lost guard
    expect(SRC).toMatch(/crm_leads_lost_reason_required/);
  });

  it('auto-logs an activity on every stage change', () => {
    expect(SRC).toMatch(/INSERT INTO crm_activities/);
    expect(SRC).toMatch(/stage_change/);
    expect(SRC).toMatch(/OLD\.stage\s*\|\|/);
    expect(SRC).toMatch(/NEW\.stage/);
  });

  it('provides auto-onboarded trigger on practice approval', () => {
    expect(SRC).toMatch(/crm_flip_lead_onboarded_on_practice_approve/);
    expect(SRC).toMatch(/AFTER UPDATE OF status ON practices/);
    expect(SRC).toMatch(/SET stage\s*=\s*'onboarded'/);
    expect(SRC).toMatch(/accepted_by_practice_id/);
  });

  it('accept_practice_invitation ALSO stamps crm_leads.converted_practice_id', () => {
    expect(SRC).toMatch(/CREATE OR REPLACE FUNCTION accept_practice_invitation/);
    expect(SRC).toMatch(/UPDATE crm_leads[\s\S]*?SET converted_practice_id/);
  });

  it('touches updated_at automatically on every UPDATE', () => {
    expect(SRC).toMatch(/trg_crm_leads_touch_updated_at/);
    expect(SRC).toMatch(/updated_at\s*:=\s*now\(\)/);
  });

  it('wires the practice_invitations.lead_id FK now that crm_leads exists', () => {
    expect(SRC).toMatch(/ALTER TABLE practice_invitations[\s\S]*?ADD CONSTRAINT[\s\S]*?FOREIGN KEY\s*\(lead_id\)\s*REFERENCES crm_leads\(id\)/i);
  });
});
