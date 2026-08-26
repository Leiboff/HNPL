import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Source-pin regressions for the CRM lead-page upgrade pass ──────
//
// Covers migration 0075 (crm_lead_contacts + street_address +
// invite-prefill), the Places-powered lead-detail address, deal-size
// removal, contacts card + mirror-rule wiring, contact-picker on
// compose, extended lead-list search, and the invite sheet.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

// ─── 0075 migration ────────────────────────────────────────────────

describe('0075 — crm_lead_contacts + street_address + invite prefill', () => {
  const SRC = read('supabase/migrations/0075_crm_lead_contacts_and_street.sql');

  it('adds street_address to crm_leads', () => {
    expect(SRC).toMatch(/ALTER TABLE crm_leads\s+ADD COLUMN IF NOT EXISTS street_address\s+TEXT/i);
  });

  it('extends practice_invitations with street/suburb/city/province', () => {
    expect(SRC).toMatch(/ALTER TABLE practice_invitations[\s\S]*?ADD COLUMN IF NOT EXISTS street_address\s+TEXT/i);
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS suburb\s+TEXT/i);
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS city\s+TEXT/i);
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS province\s+TEXT/i);
  });

  it('redefines get_practice_invitation_by_token to return the new columns', () => {
    // DROP+CREATE so the return-signature change applies cleanly on
    // databases already carrying the 0068 signature.
    expect(SRC).toMatch(/DROP FUNCTION IF EXISTS get_practice_invitation_by_token/);
    expect(SRC).toMatch(/CREATE OR REPLACE FUNCTION get_practice_invitation_by_token[\s\S]*?street_address[\s\S]*?suburb[\s\S]*?city[\s\S]*?province/);
  });

  it('creates crm_lead_contacts with the expected columns + FK cascade', () => {
    expect(SRC).toMatch(/CREATE TABLE IF NOT EXISTS crm_lead_contacts/);
    for (const col of [
      'lead_id', 'first_name', 'last_name', 'role_at_practice',
      'phone', 'email', 'is_primary', 'notes', 'created_by',
    ]) {
      expect(SRC).toMatch(new RegExp(`\\b${col}\\b`));
    }
    expect(SRC).toMatch(/REFERENCES crm_leads\(id\)\s+ON DELETE CASCADE/i);
  });

  it('enforces one primary contact per lead via a partial unique index', () => {
    expect(SRC).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS crm_lead_contacts_one_primary_per_lead[\s\S]*?WHERE is_primary/i);
  });

  it('enables RLS + admin/sales-only CRUD policies', () => {
    expect(SRC).toMatch(/ALTER TABLE crm_lead_contacts ENABLE ROW LEVEL SECURITY/);
    for (const verb of ['select', 'insert', 'update', 'delete']) {
      expect(SRC).toMatch(new RegExp(`crm_lead_contacts_admin_sales_${verb}[\\s\\S]*?IN\\s*\\(\\s*'admin'\\s*,\\s*'sales'\\s*\\)`));
    }
  });

  it('seeds a primary contact after every crm_leads INSERT (mirror rule)', () => {
    expect(SRC).toMatch(/CREATE OR REPLACE FUNCTION crm_leads_seed_primary_contact/);
    expect(SRC).toMatch(/AFTER INSERT ON crm_leads[\s\S]*?crm_leads_seed_primary_contact/);
  });

  it('mirrors lead → primary contact + primary contact → lead with IS DISTINCT FROM loop guards', () => {
    expect(SRC).toMatch(/CREATE OR REPLACE FUNCTION crm_leads_mirror_to_primary_contact/);
    expect(SRC).toMatch(/CREATE OR REPLACE FUNCTION crm_lead_contacts_mirror_to_lead/);
    // Both directions use IS DISTINCT FROM to break the loop.
    const distinctFromCount = (SRC.match(/IS DISTINCT FROM/gi) ?? []).length;
    expect(distinctFromCount).toBeGreaterThanOrEqual(3);
  });

  it('guards deletes — last row + primary-without-replacement raise check_violation', () => {
    expect(SRC).toMatch(/BEFORE DELETE ON crm_lead_contacts/);
    expect(SRC).toMatch(/cannot delete the last contact of a lead/);
    expect(SRC).toMatch(/cannot delete the primary contact/);
    expect(SRC).toMatch(/check_violation/);
  });

  it('backfills one primary contact per existing lead', () => {
    expect(SRC).toMatch(/INSERT INTO crm_lead_contacts[\s\S]*?SELECT[\s\S]*?FROM crm_leads l/);
    expect(SRC).toMatch(/WHERE NOT EXISTS[\s\S]*?crm_lead_contacts c/);
  });
});

// ─── Part A — Places-powered street address ────────────────────────

describe('PART A — Places autocomplete on lead detail + write-through to street_address', () => {
  const LDC  = read('app/crm/leads/[id]/LeadDetailClient.tsx');
  const NEW  = read('app/crm/leads/new/NewLeadForm.tsx');
  const MAP  = read('app/crm/map/MapClient.tsx');
  const ACT  = read('app/crm/leads/actions.ts');
  const PG   = read('app/crm/leads/[id]/page.tsx');

  it('lead detail imports Places + writes parsed addressLine1 into street_address', () => {
    expect(LDC).toMatch(/PlacesAutocomplete/);
    expect(LDC).toMatch(/parseAddressComponents/);
    expect(LDC).toMatch(/street_address:\s*parsed\.addressLine1/);
    expect(LDC).toMatch(/lead\.street_address/);
  });

  it('new-lead form writes parsed addressLine1 into street_address on selection', () => {
    expect(NEW).toMatch(/parseAddressComponents/);
    expect(NEW).toMatch(/street_address:\s*parsed\.addressLine1/);
  });

  it('map backfill flow passes street + suburb/city/province to updateLead', () => {
    expect(MAP).toMatch(/street:\s*parsed\.addressLine1/);
    expect(MAP).toMatch(/street_address:\s*place\.street/);
  });

  it('createLead + updateLead accept street_address', () => {
    expect(ACT).toMatch(/street_address\??:\s*string \| null/);
    expect(ACT).toMatch(/street_address:\s*input\.street_address/);
    // passthrough on updateLead includes street_address
    expect(ACT).toMatch(/passthrough[\s\S]*?['"]street_address['"]/);
  });

  it('lead-detail page fetches contacts for the ContactsCard', () => {
    expect(PG).toMatch(/from\s*\(\s*['"]crm_lead_contacts['"]\s*\)/);
    expect(PG).toMatch(/is_primary/);
  });
});

// ─── Part B — deal-size re-added (CRM Phase 2, supersedes the below) ─
//
// This block originally pinned "Est. R/mo removed from every UI
// surface" — a deliberate product decision at the time. CRM Phase 2
// explicitly reverses that decision: estimated_monthly_billings is
// "the qualification variable" and is required on the new-lead form,
// lead detail, leads list (+ sort), board cards/totals, and My Day's
// weighted-pipeline figure. The CSV importer was NOT asked to bring
// the column back (Phase 2 doesn't mention it), so those two
// assertions are left as they were.

describe('PART B — Est. R/mo (estimated_monthly_billings) wired back in, Phase 2', () => {
  const CRM   = read('app/crm/page.tsx');
  const LIST  = read('app/crm/leads/page.tsx');
  const BOARD = read('app/crm/board/BoardClient.tsx');
  const NEW   = read('app/crm/leads/new/NewLeadForm.tsx');
  const LDC   = read('app/crm/leads/[id]/LeadDetailClient.tsx');
  const CSV   = read('lib/crm/csv.ts');
  const IMP   = read('app/crm/import/actions.ts');

  it('CRM home computes a weighted pipeline figure from estimated_monthly_billings', () => {
    expect(CRM).toMatch(/estimated_monthly_billings/);
    expect(CRM).toMatch(/weightedPipelineValue/);
  });

  it('leads list displays + sorts by value', () => {
    expect(LIST).toMatch(/estimated_monthly_billings/);
    expect(LIST).toMatch(/'value'/);
  });

  it('pipeline board columns show a per-stage R total, in addition to the count', () => {
    expect(BOARD).toMatch(/estimated_monthly_billings/);
    expect(BOARD).toMatch(/formatRand/);
    expect(BOARD).toMatch(/data-testid=\{`crm-board-column-count:/);
    expect(BOARD).toMatch(/data-testid=\{`crm-board-column-value:/);
  });

  it('create-lead form has the deal-size input', () => {
    expect(NEW).toMatch(/estimated_monthly_billings/);
  });

  it('lead detail has the Est. monthly billings field', () => {
    expect(LDC).toMatch(/estimated_monthly_billings/);
  });

  it('CSV parser still does not carry estimated_monthly_billings (unchanged by Phase 2 — not asked for)', () => {
    expect(CSV).not.toMatch(/estimated_monthly_billings:\s*number/);
  });

  it('CSV commit still does not write estimated_monthly_billings (unchanged by Phase 2 — not asked for)', () => {
    expect(IMP).not.toMatch(/estimated_monthly_billings/);
  });
});

// ─── Part C — contacts card + mirror + picker + search ─────────────

describe('PART C — contacts card + compose picker + list search extension', () => {
  const CA   = read('app/crm/leads/[id]/contactsActions.ts');
  const CC   = read('app/crm/leads/[id]/ContactsCard.tsx');
  const LDC  = read('app/crm/leads/[id]/LeadDetailClient.tsx');
  const CES  = read('app/crm/leads/[id]/ComposeEmailSheet.tsx');
  const CE   = read('app/crm/leads/[id]/composeEmail.ts');
  const LIST = read('app/crm/leads/page.tsx');

  it('contactsActions exports the four CRUD server actions (all async, use-server)', () => {
    expect(CA).toMatch(/^'use server';/);
    expect(CA).toMatch(/export async function addContact/);
    expect(CA).toMatch(/export async function updateContact/);
    expect(CA).toMatch(/export async function promotePrimary/);
    expect(CA).toMatch(/export async function removeContact/);
  });

  it('ContactsCard renders primary badge + Reply/tap-to-call/tap-to-compose affordances', () => {
    expect(CC).toMatch(/data-testid="contacts-card"/);
    expect(CC).toMatch(/data-testid=\{`contact-primary-badge:/);
    expect(CC).toMatch(/data-testid=\{`contact-phone:/);
    expect(CC).toMatch(/data-testid=\{`contact-email:/);
    expect(CC).toMatch(/href=\{`tel:/);
    expect(CC).toMatch(/href=\{`mailto:/);
    expect(CC).toMatch(/data-testid=\{`contact-promote:/);
    expect(CC).toMatch(/data-testid=\{`contact-remove:/);
  });

  it('removing the primary promotes another contact first (matches the DB guard)', () => {
    expect(CC).toMatch(/makePrimary/);
    expect(CC).toMatch(/promotePrimary/);
  });

  it('LeadDetailClient wires the ContactsCard + passes contacts to compose sheet', () => {
    expect(LDC).toMatch(/import ContactsCard/);
    expect(LDC).toMatch(/<ContactsCard[\s\S]*?contacts=\{contacts\}/);
    expect(LDC).toMatch(/<ComposeEmailSheet[\s\S]*?contacts=\{contacts\.map/);
  });

  it('ComposeEmailSheet exposes a To picker in fresh mode + threads recipientEmailOverride to send', () => {
    expect(CES).toMatch(/data-testid="compose-contact-picker"/);
    expect(CES).toMatch(/data-testid="compose-to-picker"/);
    expect(CES).toMatch(/recipientEmailOverride:\s*replyMode \?\s*undefined\s*:\s*\(recipientEmail/);
  });

  it('sendComposedEmail honours recipientEmailOverride (non-reply mode)', () => {
    expect(CE).toMatch(/recipientEmailOverride\?:\s*string/);
    expect(CE).toMatch(/input\.recipientEmailOverride/);
  });

  it('lead list search extends to non-primary contacts via crm_lead_contacts pre-fetch', () => {
    expect(LIST).toMatch(/from\s*\(\s*['"]crm_lead_contacts['"]\s*\)/);
    expect(LIST).toMatch(/first_name\.ilike/);
    expect(LIST).toMatch(/extraLeadIds/);
    expect(LIST).toMatch(/id\.in\.\(/);
  });
});

// ─── Part D — signup flow upgrade ──────────────────────────────────

describe('PART D — Mark signed → invite becomes a full send-and-prefill flow', () => {
  const IS  = read('app/crm/leads/[id]/InviteSheet.tsx');
  const ACT = read('app/crm/leads/actions.ts');
  const SP  = read('app/signup/practice/page.tsx');
  const SPA = read('app/signup/practice/actions.ts');
  const MF  = read('lib/gmail/mergeFields.ts');

  it('markSigned accepts a contactId + stamps the invite with that contact + lead address', () => {
    expect(ACT).toMatch(/export async function markSigned\(\s*leadId:\s*string,\s*opts\?:\s*\{\s*contactId\?/);
    expect(ACT).toMatch(/crm_lead_contacts/);
    // Invite row now carries the address prefill columns from lead.
    expect(ACT).toMatch(/street_address:\s*lead\.street_address/);
    expect(ACT).toMatch(/suburb:\s*lead\.suburb/);
    expect(ACT).toMatch(/city:\s*lead\.city/);
    expect(ACT).toMatch(/province:\s*lead\.province/);
  });

  it('InviteSheet is a sheet with a contact picker, subject/body editable, and two actions', () => {
    expect(IS).toMatch(/data-testid="invite-sheet"/);
    expect(IS).toMatch(/data-testid="invite-contact-picker"/);
    expect(IS).toMatch(/data-testid="invite-subject"/);
    expect(IS).toMatch(/data-testid="invite-body"/);
    expect(IS).toMatch(/data-testid="invite-send-gmail"/);
    expect(IS).toMatch(/data-testid="invite-copy-link"/);
  });

  it('InviteSheet reuses sendComposedEmail with the picked contact’s email as recipient override', () => {
    expect(IS).toMatch(/sendComposedEmail\(\{[\s\S]*?recipientEmailOverride:\s*recipient/);
  });

  it('InviteSheet degrades gracefully when the user has no connected Gmail account', () => {
    expect(IS).toMatch(/data-testid="invite-no-gmail"/);
  });

  it('invite template supports the {{invite_link}} merge field', () => {
    expect(MF).toMatch(/invite_link\??:\s*string \| null/);
    expect(MF).toMatch(/invite_link/);
    expect(IS).toMatch(/\{\{invite_link\}\}/);
  });

  it('/signup/practice prefill payload + client both extend to address fields', () => {
    expect(SPA).toMatch(/street_address:\s*string \| null/);
    expect(SPA).toMatch(/suburb:\s*string \| null/);
    expect(SP).toMatch(/addressLine1:\s*pre\.street_address/);
    expect(SP).toMatch(/suburb:\s*pre\.suburb/);
    expect(SP).toMatch(/city:\s*pre\.city/);
    expect(SP).toMatch(/province:\s*pre\.province/);
  });
});

// ─── Sanity: files present, no rogue extra migration ──────────────

describe('files present', () => {
  const FILES = [
    'supabase/migrations/0075_crm_lead_contacts_and_street.sql',
    'app/crm/leads/[id]/ContactsCard.tsx',
    'app/crm/leads/[id]/contactsActions.ts',
    'app/crm/leads/[id]/InviteSheet.tsx',
  ];
  it.each(FILES)('%s exists', (p) => {
    expect(existsSync(resolve(ROOT, p))).toBe(true);
  });

  it('no extra migration this pass', () => {
    expect(existsSync(resolve(ROOT, 'supabase/migrations/0076_crm_extras.sql'))).toBe(false);
  });
});
