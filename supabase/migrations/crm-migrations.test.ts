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

describe('0070 — conversion hardening', () => {
  const SRC = read('supabase/migrations/0070_crm_conversion_hardening.sql');

  it('redefines accept_practice_invitation with SECURITY DEFINER + pinned search_path', () => {
    expect(SRC).toMatch(/CREATE OR REPLACE FUNCTION accept_practice_invitation/);
    expect(SRC).toMatch(/SECURITY DEFINER/);
    expect(SRC).toMatch(/SET search_path\s*=\s*public/);
  });

  it('accept_practice_invitation checks caller owns p_practice_id (with service-role bypass)', () => {
    expect(SRC).toMatch(/auth\.role\(\)\s*=\s*'service_role'/);
    // The ownership check must consult BOTH practices.owner_id AND practice_members
    expect(SRC).toMatch(/practices[\s\S]*?owner_id\s*=\s*auth\.uid\(\)/i);
    expect(SRC).toMatch(/practice_members[\s\S]*?user_id\s*=\s*auth\.uid\(\)/i);
    // And raises insufficient_privilege on failure
    expect(SRC).toMatch(/insufficient_privilege/);
  });

  it('wraps the CRM flip in BEGIN/EXCEPTION so approval cannot be aborted', () => {
    expect(SRC).toMatch(/CREATE OR REPLACE FUNCTION crm_flip_lead_onboarded_on_practice_approve/);
    expect(SRC).toMatch(/EXCEPTION\s+WHEN\s+OTHERS\s+THEN/i);
    expect(SRC).toMatch(/RAISE\s+WARNING/i);
  });

  it('trigger function still only fires on the pending → approved transition', () => {
    expect(SRC).toMatch(/NEW\.status\s*=\s*'approved'/);
    expect(SRC).toMatch(/OLD\.status\s+IS\s+DISTINCT\s+FROM\s+'approved'/);
  });
});

describe('0115 — contact interest + decision-maker', () => {
  const SRC = read('supabase/migrations/0115_crm_contact_interest_and_decision_maker.sql');

  it('adds interest with the four-value CHECK vocabulary, defaulting to unknown', () => {
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS interest TEXT NOT NULL DEFAULT 'unknown'/);
    for (const v of ['unknown', 'cold', 'warm', 'hot']) {
      expect(SRC).toMatch(new RegExp(`['"]${v}['"]`));
    }
  });

  it('adds is_decision_maker as a plain boolean with no uniqueness constraint', () => {
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS is_decision_maker BOOLEAN NOT NULL DEFAULT FALSE/);
    expect(SRC).not.toMatch(/UNIQUE INDEX[\s\S]*is_decision_maker/);
  });

  it('backfills is_decision_maker from is_primary, not from scratch', () => {
    expect(SRC).toMatch(/UPDATE crm_lead_contacts SET is_decision_maker = TRUE WHERE is_primary IS TRUE/);
  });

  it('does not touch crm_leads — interest is never mirrored', () => {
    expect(SRC).not.toMatch(/ALTER TABLE crm_leads\b/);
    expect(SRC).not.toMatch(/UPDATE crm_leads\b/);
  });

  it('the pre-existing 0075 mirror triggers do not reference interest/is_decision_maker', () => {
    const mirrorSrc = read('supabase/migrations/0075_crm_lead_contacts_and_street.sql');
    expect(mirrorSrc).not.toMatch(/interest/i);
    expect(mirrorSrc).not.toMatch(/is_decision_maker/i);
  });
});

describe('0116 — nurture stage + wake date', () => {
  const SRC = read('supabase/migrations/0116_crm_nurture_stage.sql');

  it('adds nurture to crm_leads.stage, and to both from_stage/to_stage on crm_activities', () => {
    expect(SRC).toMatch(/crm_leads_stage_check[\s\S]*?CHECK \(stage IN \([\s\S]*?'nurture'/);
    expect(SRC).toMatch(/crm_activities_from_stage_check[\s\S]*?'nurture'/);
    expect(SRC).toMatch(/crm_activities_to_stage_check[\s\S]*?'nurture'/);
  });

  it('adds nurture_wake_at as a plain nullable timestamptz', () => {
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS nurture_wake_at TIMESTAMPTZ/);
  });

  it('enforces nurture requires nurture_wake_at via trigger AND a table-level CHECK (mirrors lost_reason)', () => {
    expect(SRC).toMatch(/NEW\.stage = 'nurture' AND NEW\.nurture_wake_at IS NULL/);
    expect(SRC).toMatch(/nurture_wake_at is required/i);
    expect(SRC).toMatch(/crm_leads_nurture_wake_at_required[\s\S]*?CHECK[\s\S]*?stage <> 'nurture' OR nurture_wake_at IS NOT NULL/);
  });
});

describe('0117 — address dedupe fields + suggestion dismissals', () => {
  const SRC = read('supabase/migrations/0117_crm_address_dedupe.sql');

  it('adds building_name/unit/landline/address_match_key to crm_leads', () => {
    for (const col of ['building_name', 'unit', 'landline', 'address_match_key']) {
      expect(SRC).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\s+TEXT`));
    }
  });

  it('populates address_match_key via a BEFORE INSERT/UPDATE trigger, not a mirror trigger on crm_lead_contacts', () => {
    expect(SRC).toMatch(/BEFORE INSERT OR UPDATE ON crm_leads/);
    expect(SRC).toMatch(/crm_leads_set_address_match_key/);
  });

  it('creates crm_suggestion_dismissals with the lower-UUID-first ordering enforced by a CHECK', () => {
    expect(SRC).toMatch(/CREATE TABLE IF NOT EXISTS crm_suggestion_dismissals/);
    expect(SRC).toMatch(/CHECK \(lead_a_id < lead_b_id\)/);
    expect(SRC).toMatch(/UNIQUE INDEX[\s\S]*?crm_suggestion_dismissals\(lead_a_id, lead_b_id, kind\)/);
  });

  it('crm_suggestion_dismissals has RLS with the standard admin/sales predicate, and no UPDATE policy', () => {
    expect(SRC).toMatch(/ALTER TABLE crm_suggestion_dismissals ENABLE ROW LEVEL SECURITY/);
    expect(SRC).toMatch(/crm_suggestion_dismissals_admin_sales_select/);
    expect(SRC).toMatch(/crm_suggestion_dismissals_admin_sales_insert/);
    expect(SRC).not.toMatch(/crm_suggestion_dismissals_admin_sales_update/);
  });

  it('does not drop or alter crm_leads_practice_suburb_uidx (0111) — that constraint is reported on, not silently changed', () => {
    expect(SRC).not.toMatch(/DROP.*crm_leads_practice_suburb_uidx/i);
  });
});

describe('0118 — practitioner HPCSA grouping', () => {
  const SRC = read('supabase/migrations/0118_crm_practitioner_hpcsa_grouping.sql');

  it('adds hpcsa_number + hpcsa_group_key to crm_lead_contacts', () => {
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS hpcsa_number\s+TEXT/);
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS hpcsa_group_key\s+TEXT/);
  });

  it('matches the 0064 precedent\'s exact normalisation: NULL/empty-after-trim -> NULL, else md5(lower(trim(x)))', () => {
    // Deliberately does NOT read 0064's file by name here — doing so
    // would trip app/patient/explore/practitioners-directory.test.ts's
    // single-callsite scanner for that view's identifier. The shape is
    // pinned directly against this migration's own SQL instead.
    expect(SRC).toMatch(/LENGTH\(TRIM\(NEW\.hpcsa_number\)\)\s*=\s*0/);
    expect(SRC).toMatch(/md5\(LOWER\(TRIM\(NEW\.hpcsa_number\)\)\)/);
  });

  it('does not introduce a separate people table', () => {
    expect(SRC).not.toMatch(/CREATE TABLE/i);
  });

  it('does not touch any patient-facing view — raw HPCSA stays internal to the CRM', () => {
    expect(SRC).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?VIEW/i);
    expect(SRC).not.toMatch(/GRANT\s+SELECT\s+ON/i);
  });
});
