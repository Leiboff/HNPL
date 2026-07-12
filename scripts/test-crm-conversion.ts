/**
 * CRM conversion — RPC-level behavioural tests against the LIVE database.
 *
 * Purpose: verify the two hardening changes in migration 0070 by
 * exercising the actual RPC + trigger from the client's perspective.
 * This complements the source-pin tests (crm-migrations.test.ts) — those
 * pin the shape; this one pins the runtime behaviour.
 *
 * Scenarios covered:
 *
 *   1. Signup path (service-role caller):
 *      - create lead + invitation
 *      - call accept_practice_invitation(token, own_practice_id) as svc
 *      - assert invitation.accepted_at + accepted_by_practice_id set,
 *        crm_leads.converted_practice_id stamped, lead_id returned.
 *
 *   2. Authenticated caller redeeming their OWN practice:
 *      - as an authenticated user owning practice A, call the RPC with
 *        practice A's id. Assert stamping succeeds.
 *
 *   3. Authenticated caller with ANOTHER user's practice_id:
 *      - assert the RPC raises insufficient_privilege and NO state
 *        changes (invitation still unaccepted, lead still unstamped).
 *
 *   4. Anonymous caller (no session):
 *      - assert the RPC raises insufficient_privilege.
 *
 *   5. Expired token:
 *      - insert an already-expired invitation; call the RPC via svc.
 *      - assert the WHERE clause matches nothing (v_lead_id NULL,
 *        invitation still unaccepted, lead still unstamped).
 *
 *   6. Already-accepted token:
 *      - re-call the RPC on scenario-1's now-accepted token via svc.
 *      - assert idempotent NULL return, no changes to invitation.
 *
 *   7. Approve a practice with NO linked lead — the auto-onboarded
 *      trigger fires but finds no matching row, approval succeeds.
 *
 *   8. Approve a practice whose linked lead is in an UNEXPECTED stage
 *      (e.g. 'new') — approval still succeeds, no CRM change.
 *
 * Usage:
 *   pnpm run test:crm-conversion
 *
 * Requires env in .env.local (loaded by --env-file):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Creates + cleans up throw-away rows. Refuses to run against a prod
 * URL by inspecting the URL for 'prod' / 'live' substrings.
 */

import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !KEY) {
  console.error('✗ Missing env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (/prod|live/i.test(SUPABASE_URL)) {
  console.error('✗ Refusing to run against a URL containing "prod" or "live"');
  process.exit(1);
}

const svc = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false } });

// ── Logging helpers ────────────────────────────────────────────────────

const T0 = Date.now();
const ms = () => `${String(Date.now() - T0).padStart(5)}ms`;
function h1(label: string)   { console.log(`\n\x1b[36m━━ ${label} ${'━'.repeat(Math.max(0, 68 - label.length))}\x1b[0m`); }
function info(label: string) { console.log(`[${ms()}] ${label}`); }
function ok(label: string)   { console.log(`[${ms()}] \x1b[32m✓\x1b[0m ${label}`); }
function bad(label: string)  { console.log(`[${ms()}] \x1b[31m✗\x1b[0m ${label}`);  failed++; }

let failed = 0;

async function assertEq<T>(label: string, actual: T, expected: T) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(`${label} — ${JSON.stringify(actual)}`);
  else                                                     bad(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function assertNotEq<T>(label: string, actual: T, notExpected: T) {
  if (JSON.stringify(actual) !== JSON.stringify(notExpected)) ok(`${label} — ${JSON.stringify(actual)}`);
  else                                                        bad(`${label} — value should not equal ${JSON.stringify(notExpected)}`);
}

// ── Fixture bootstrap ──────────────────────────────────────────────────
//
// We need real profiles + practices for the ownership check to matter.
// The fixture creates two auth users (owners of practice A + B) via the
// admin API, plus a sales user for the lead-creation step, plus an
// admin user to test approval.

type Fixture = {
  adminUserId:     string;
  salesUserId:     string;
  practiceAOwner:  string;
  practiceBOwner:  string;
  practiceAId:     string;
  practiceBId:     string;
  brandAId:        string;
  brandBId:        string;
};

const RUN_TAG = `crm-conv-${Date.now().toString(36)}`;

async function ensureUser(email: string, role: 'admin' | 'sales' | 'practice_admin'): Promise<string> {
  const { data: existing } = await svc.from('profiles').select('id').eq('email', email).maybeSingle();
  if (existing?.id) {
    await svc.from('profiles').update({ role }).eq('id', existing.id);
    return existing.id;
  }
  const password = randomBytes(16).toString('hex');
  const { data, error } = await svc.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { role, first_name: 'Test', last_name: role },
  });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
  const id = data.user.id;
  // handle_new_user() trigger creates profile with role from metadata; if it
  // doesn't fire (edge case) we upsert here.
  await svc.from('profiles').upsert({ id, email, role, first_name: 'Test', last_name: role });
  return id;
}

async function ensurePractice(owner: string, tag: string): Promise<{ practice_id: string; brand_id: string }> {
  const { data: brand, error: brandErr } = await svc
    .from('practice_groups')
    .insert({ name: `${RUN_TAG} — ${tag} brand`, status: 'active', created_by: owner })
    .select('id')
    .single();
  if (brandErr || !brand) throw new Error(`brand insert: ${brandErr?.message}`);

  const { data: pr, error: prErr } = await svc
    .from('practices')
    .insert({
      owner_id:  owner,
      group_id:  brand.id,
      name:      `${RUN_TAG} — ${tag}`,
      specialty: 'Dentistry',
      email:     `${RUN_TAG}-${tag}@test.example`,
      status:    'pending',
    })
    .select('id')
    .single();
  if (prErr || !pr) throw new Error(`practice insert: ${prErr?.message}`);

  await svc.from('practice_members').insert({
    practice_id: pr.id, user_id: owner, role: 'admin', active: true,
    can_create_bills: true, can_manage_practice: true, payout_destination: 'practice',
  });

  return { practice_id: pr.id, brand_id: brand.id };
}

async function bootstrap(): Promise<Fixture> {
  h1('Bootstrap fixture');
  const adminUserId    = await ensureUser(`${RUN_TAG}-admin@test.example`,  'admin');
  const salesUserId    = await ensureUser(`${RUN_TAG}-sales@test.example`,  'sales');
  const practiceAOwner = await ensureUser(`${RUN_TAG}-ownerA@test.example`, 'practice_admin');
  const practiceBOwner = await ensureUser(`${RUN_TAG}-ownerB@test.example`, 'practice_admin');
  info(`admin: ${adminUserId}`); info(`sales: ${salesUserId}`);
  info(`ownerA: ${practiceAOwner}`); info(`ownerB: ${practiceBOwner}`);
  const a = await ensurePractice(practiceAOwner, 'A');
  const b = await ensurePractice(practiceBOwner, 'B');
  info(`practice A: ${a.practice_id}`);
  info(`practice B: ${b.practice_id}`);
  ok('Fixture ready');
  return {
    adminUserId, salesUserId,
    practiceAOwner, practiceBOwner,
    practiceAId: a.practice_id, practiceBId: b.practice_id,
    brandAId: a.brand_id,       brandBId: b.brand_id,
  };
}

async function createLeadAndInvite(f: Fixture, opts?: { expired?: boolean }): Promise<{ leadId: string; token: string }> {
  const { data: lead, error: leadErr } = await svc.from('crm_leads').insert({
    practice_name:      `${RUN_TAG} lead`,
    contact_first_name: 'Test',
    contact_last_name:  'Contact',
    email:              `${RUN_TAG}-lead-${randomBytes(3).toString('hex')}@test.example`,
    source:             'other',
    stage:              'signed',
    owner_user_id:      f.salesUserId,
    created_by:         f.salesUserId,
  }).select('id').single();
  if (leadErr || !lead) throw new Error(`lead insert: ${leadErr?.message}`);

  const token = randomBytes(32).toString('hex');
  const { error: invErr } = await svc.from('practice_invitations').insert({
    email:        `${RUN_TAG}-invite@test.example`,
    practice_name: `${RUN_TAG} practice`,
    lead_id:      lead.id,
    invited_by:   f.salesUserId,
    token,
    expires_at:   opts?.expired
      ? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (invErr) throw new Error(`invitation insert: ${invErr?.message}`);
  return { leadId: lead.id, token };
}

async function fetchInvite(token: string) {
  const { data } = await svc.from('practice_invitations').select('accepted_at, accepted_by_practice_id, lead_id').eq('token', token).maybeSingle();
  return data;
}
async function fetchLead(id: string) {
  const { data } = await svc.from('crm_leads').select('id, stage, converted_practice_id').eq('id', id).maybeSingle();
  return data;
}

async function userClient(userId: string, email: string) {
  // Mint a magic link and use the returned session to sign in the user
  // in a fresh (non-persistent) client.
  const { data: link, error } = await svc.auth.admin.generateLink({ type: 'magiclink', email });
  if (error || !link.properties?.action_link) throw new Error(`generateLink for ${email}: ${error?.message}`);
  const parsed = new URL(link.properties.action_link);
  const tokenHash = parsed.searchParams.get('token');
  const type      = parsed.searchParams.get('type');
  if (!tokenHash || !type) throw new Error('magiclink missing token/type');
  const client = createClient(SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? KEY!, { auth: { persistSession: false } });
  const { data: verified, error: vErr } = await client.auth.verifyOtp({ type: type as 'magiclink', token_hash: tokenHash });
  if (vErr || !verified.session) throw new Error(`verifyOtp: ${vErr?.message}`);
  await client.auth.setSession({ access_token: verified.session.access_token, refresh_token: verified.session.refresh_token });
  // Sanity: getUser should return the same id
  const { data: u } = await client.auth.getUser();
  if (u.user?.id !== userId) throw new Error(`session mismatch: got ${u.user?.id}, expected ${userId}`);
  return client;
}

async function cleanup(f: Fixture) {
  h1('Cleanup');
  // Delete practices first (cascades practice_members via 0044/0045; brand cascades practice_group_members)
  await svc.from('practices').delete().in('id', [f.practiceAId, f.practiceBId]);
  await svc.from('practice_groups').delete().in('id', [f.brandAId, f.brandBId]);
  // Delete throw-away leads + invites keyed on RUN_TAG (defensive; some tests create their own)
  await svc.from('practice_invitations').delete().ilike('practice_name', `${RUN_TAG}%`);
  await svc.from('crm_leads').delete().ilike('practice_name', `${RUN_TAG}%`);
  // Delete users last
  for (const id of [f.adminUserId, f.salesUserId, f.practiceAOwner, f.practiceBOwner]) {
    await svc.auth.admin.deleteUser(id);
  }
  ok('Cleanup done');
}

// ── Test runner ────────────────────────────────────────────────────────

async function main() {
  const f = await bootstrap();
  try {

    // ── Scenario 1: service-role signup path ─────────────────────────
    h1('Scenario 1 — service-role signup path (happy path)');
    {
      const { leadId, token } = await createLeadAndInvite(f);
      const { data, error } = await svc.rpc('accept_practice_invitation', {
        p_token: token, p_practice_id: f.practiceAId,
      });
      if (error) bad(`svc rpc error: ${error.message}`);
      else       ok(`RPC returned lead_id: ${data}`);
      const inv  = await fetchInvite(token);
      const lead = await fetchLead(leadId);
      assertEq('invitation.accepted_by_practice_id', inv?.accepted_by_practice_id, f.practiceAId);
      assertNotEq('invitation.accepted_at set',       inv?.accepted_at,             null);
      assertEq('lead.converted_practice_id',          lead?.converted_practice_id,  f.practiceAId);
    }

    // ── Scenario 2: authenticated caller redeeming their OWN practice
    h1('Scenario 2 — authenticated owner of practice A redeems for A');
    {
      const { leadId, token } = await createLeadAndInvite(f);
      const client = await userClient(f.practiceAOwner, `${RUN_TAG}-ownerA@test.example`);
      const { data, error } = await client.rpc('accept_practice_invitation', {
        p_token: token, p_practice_id: f.practiceAId,
      });
      if (error) bad(`ownerA rpc error: ${error.message}`);
      else       ok(`RPC returned lead_id: ${data}`);
      const lead = await fetchLead(leadId);
      assertEq('lead.converted_practice_id after ownerA redeem', lead?.converted_practice_id, f.practiceAId);
    }

    // ── Scenario 3: ownerA calls with practice B's id ────────────────
    h1('Scenario 3 — ownerA attempts to redeem for practice B (must reject)');
    {
      const { leadId, token } = await createLeadAndInvite(f);
      const client = await userClient(f.practiceAOwner, `${RUN_TAG}-ownerA@test.example`);
      const { error } = await client.rpc('accept_practice_invitation', {
        p_token: token, p_practice_id: f.practiceBId,
      });
      if (!error) bad('expected rejection but call succeeded');
      else        ok(`Rejected as expected: ${error.message}`);
      const inv  = await fetchInvite(token);
      const lead = await fetchLead(leadId);
      assertEq('invitation still unaccepted',       inv?.accepted_at,            null);
      assertEq('invitation not linked to any practice', inv?.accepted_by_practice_id, null);
      assertEq('lead still unstamped',              lead?.converted_practice_id, null);
    }

    // ── Scenario 4: anonymous caller ─────────────────────────────────
    h1('Scenario 4 — anonymous (no session) caller (must reject)');
    {
      const { leadId, token } = await createLeadAndInvite(f);
      const anon = createClient(SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', { auth: { persistSession: false } });
      const { error } = await anon.rpc('accept_practice_invitation', {
        p_token: token, p_practice_id: f.practiceAId,
      });
      if (!error) bad('expected rejection but anon call succeeded');
      else        ok(`Rejected as expected: ${error.message}`);
      const inv  = await fetchInvite(token);
      const lead = await fetchLead(leadId);
      assertEq('invitation still unaccepted (anon)', inv?.accepted_at,            null);
      assertEq('lead still unstamped (anon)',        lead?.converted_practice_id, null);
    }

    // ── Scenario 5: expired token ────────────────────────────────────
    h1('Scenario 5 — expired token (must no-op)');
    {
      const { leadId, token } = await createLeadAndInvite(f, { expired: true });
      const { data, error } = await svc.rpc('accept_practice_invitation', {
        p_token: token, p_practice_id: f.practiceAId,
      });
      if (error)          bad(`unexpected error: ${error.message}`);
      else                ok(`RPC returned ${data} (null expected)`);
      assertEq('lead_id returned for expired', data, null);
      const inv  = await fetchInvite(token);
      const lead = await fetchLead(leadId);
      assertEq('expired invitation still unaccepted', inv?.accepted_at,            null);
      assertEq('lead still unstamped (expired)',      lead?.converted_practice_id, null);
    }

    // ── Scenario 6: already-accepted token (idempotency) ─────────────
    h1('Scenario 6 — already-accepted token (must return null idempotently)');
    {
      const { leadId, token } = await createLeadAndInvite(f);
      // First call to accept
      await svc.rpc('accept_practice_invitation', { p_token: token, p_practice_id: f.practiceAId });
      const invBefore = await fetchInvite(token);
      // Second call — should return null and not overwrite
      const { data, error } = await svc.rpc('accept_practice_invitation', {
        p_token: token, p_practice_id: f.practiceBId,   // different practice_id on retry
      });
      if (error) bad(`unexpected error: ${error.message}`);
      else       ok(`RPC returned ${data} (null expected)`);
      assertEq('lead_id returned on 2nd call', data, null);
      const invAfter = await fetchInvite(token);
      const lead     = await fetchLead(leadId);
      assertEq('accepted_by_practice_id unchanged', invAfter?.accepted_by_practice_id, invBefore?.accepted_by_practice_id);
      assertEq('lead still points to first accepter', lead?.converted_practice_id, f.practiceAId);
    }

    // ── Scenario 7: approve practice with no linked lead ─────────────
    h1('Scenario 7 — approve a practice with NO linked invitation/lead');
    {
      // Practice A has no invitation linked (Scenario 1 created a lead but
      // linked it to practice A too; use a fresh practice for clarity)
      const owner = await ensureUser(`${RUN_TAG}-owner-solo@test.example`, 'practice_admin');
      const { practice_id, brand_id } = await ensurePractice(owner, 'SOLO');
      try {
        const { error } = await svc.from('practices').update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          approved_by: f.adminUserId,
        }).eq('id', practice_id);
        if (error) bad(`approval failed: ${error.message}`);
        else       ok(`approval succeeded with no linked lead`);
      } finally {
        await svc.from('practices').delete().eq('id', practice_id);
        await svc.from('practice_groups').delete().eq('id', brand_id);
        await svc.auth.admin.deleteUser(owner);
      }
    }

    // ── Scenario 8: linked lead in unexpected stage — approval still succeeds
    h1('Scenario 8 — linked lead in unexpected stage — approval still succeeds');
    {
      // Fresh setup: lead in stage='new', invite pointing to a fresh practice.
      const owner = await ensureUser(`${RUN_TAG}-owner-newstage@test.example`, 'practice_admin');
      const { practice_id, brand_id } = await ensurePractice(owner, 'NEWSTAGE');
      const { data: lead } = await svc.from('crm_leads').insert({
        practice_name:      `${RUN_TAG} newstage lead`,
        contact_first_name: 'Test',
        contact_last_name:  'Contact',
        email:              `${RUN_TAG}-newstage@test.example`,
        source:             'other',
        stage:              'new',
        owner_user_id:      f.salesUserId,
        created_by:         f.salesUserId,
      }).select('id').single();
      const token = randomBytes(32).toString('hex');
      await svc.from('practice_invitations').insert({
        email:              `${RUN_TAG}-newstage-inv@test.example`,
        practice_name:      `${RUN_TAG} newstage`,
        lead_id:            lead!.id,
        invited_by:         f.salesUserId,
        token,
        accepted_at:        new Date().toISOString(),
        accepted_by_practice_id: practice_id,
      });
      try {
        const { error } = await svc.from('practices').update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          approved_by: f.adminUserId,
        }).eq('id', practice_id);
        if (error) bad(`approval failed: ${error.message}`);
        else       ok(`approval succeeded despite unexpected lead stage`);
        const after = await fetchLead(lead!.id);
        assertEq('lead stage unchanged (was "new")', after?.stage, 'new');
      } finally {
        await svc.from('practices').delete().eq('id', practice_id);
        await svc.from('practice_groups').delete().eq('id', brand_id);
        await svc.auth.admin.deleteUser(owner);
      }
    }

    // ── Scenario 9: happy path onboarded flip ─────────────────────────
    h1('Scenario 9 — practice approval flips signed → onboarded');
    {
      const owner = await ensureUser(`${RUN_TAG}-owner-happy@test.example`, 'practice_admin');
      const { practice_id, brand_id } = await ensurePractice(owner, 'HAPPY');
      const { data: lead } = await svc.from('crm_leads').insert({
        practice_name:      `${RUN_TAG} happy lead`,
        contact_first_name: 'Test',
        contact_last_name:  'Contact',
        email:              `${RUN_TAG}-happy@test.example`,
        source:             'other',
        stage:              'signed',
        owner_user_id:      f.salesUserId,
        created_by:         f.salesUserId,
      }).select('id').single();
      const token = randomBytes(32).toString('hex');
      await svc.from('practice_invitations').insert({
        email:                    `${RUN_TAG}-happy-inv@test.example`,
        practice_name:            `${RUN_TAG} happy`,
        lead_id:                  lead!.id,
        invited_by:               f.salesUserId,
        token,
        accepted_at:              new Date().toISOString(),
        accepted_by_practice_id:  practice_id,
      });
      try {
        await svc.from('practices').update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          approved_by: f.adminUserId,
        }).eq('id', practice_id);
        const after = await fetchLead(lead!.id);
        assertEq('lead stage flipped to onboarded', after?.stage, 'onboarded');
      } finally {
        await svc.from('practices').delete().eq('id', practice_id);
        await svc.from('practice_groups').delete().eq('id', brand_id);
        await svc.auth.admin.deleteUser(owner);
      }
    }

  } finally {
    await cleanup(f);
  }

  h1('Summary');
  if (failed === 0) console.log(`[${ms()}] \x1b[32m✓ all assertions passed\x1b[0m`);
  else               { console.log(`[${ms()}] \x1b[31m✗ ${failed} failed assertion(s)\x1b[0m`); process.exit(1); }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
