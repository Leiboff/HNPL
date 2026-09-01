import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Roster providers + the invite-later path ───────────────────────────
//
// Source-level pins for the parts that are structure rather than callable
// behaviour: which flow requires an email, which action a form is wired to,
// and — the one that matters most — that the ADMIN-STAFF INVITE PATH IS
// UNTOUCHED. That path was explicitly out of scope, so "I didn't change it"
// needs to be an assertion rather than a claim.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

/** Comments legitimately DISCUSS what was removed; code must not contain it. */
const codeOf = (src: string) => stripComments(src, { jsxBraces: true });

const ACTIONS   = read('app/practice/members/actions.ts');
const INVITE    = read('lib/brand/inviteMember.ts');
const ADD_PROV  = read('app/practice/members/AddProviderForm.tsx');
const ADD_FORM  = read('app/practice/members/AddMemberForm.tsx');
const INV_LOGIN = read('app/practice/members/InviteLoginForm.tsx');
const VIEW      = read('app/practice/members/MembersView.tsx');
const PAGE      = read('app/practice/members/page.tsx');
const PROVIDER  = read('app/provider/page.tsx');
const PROV_LAY  = read('app/provider/layout.tsx');
const MIG        = read('supabase/migrations/0091_roster_providers_without_login.sql');

/** Body of a named exported function, up to the next top-level export. */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const rest = src.slice(start + 10);
  const next = rest.search(/\nexport (async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

// ─── Adding a practitioner needs no email ───────────────────────────────

describe('addProviderToRoster — no email, no invite', () => {
  const body = bodyOf(ACTIONS, 'addProviderToRoster');

  it('exists and is guarded by the SAME guardManager as every other action', () => {
    expect(body).toMatch(/await guardManager\(\)/);
  });

  it('takes no email and sends no invitation', () => {
    const code = codeOf(body);
    expect(code).not.toMatch(/email/i);
    expect(code).not.toMatch(/invite/i);
    expect(code).not.toMatch(/isValidEmail/);
  });

  it('writes user_id: null — the row that authorises nothing', () => {
    expect(codeOf(body)).toMatch(/user_id:\s*null/);
  });

  it('requires specialty AND HPCSA, validating HPCSA shape', () => {
    expect(body).toMatch(/Specialty is required/);
    expect(body).toMatch(/checkHpcsa\(hpcsa\)/);
    expect(body).toMatch(/HPCSA_ERROR_MESSAGE/);
  });

  it('takes no SA ID — there is nobody to complete an identity ceremony', () => {
    expect(codeOf(body)).not.toMatch(/saId|sa_id/i);
  });

  it('grants no capabilities and writes the practice payout destination', () => {
    const code = codeOf(body);
    expect(code).toMatch(/can_create_bills:\s*false/);
    expect(code).toMatch(/can_manage_practice:\s*false/);
    expect(code).toMatch(/payout_destination:\s*'practice'/);
  });

  it('revalidates the dashboard too — the first provider can unblock trading', () => {
    expect(body).toMatch(/revalidatePath\('\/practice'\)/);
  });
});

// ─── The optional second step ───────────────────────────────────────────

describe('inviteLoginForRosterMember — links, never inserts', () => {
  const body = INVITE.slice(INVITE.indexOf('export async function inviteLoginForRosterMember'));

  it('UPDATES the existing row rather than inserting a second one', () => {
    const code = codeOf(body);
    expect(code).toMatch(/\.update\(\{/);
    expect(code).toMatch(/user_id:\s*newUserId/);
    // A second membership row would split one practitioner's identity in two.
    expect(code).not.toMatch(/\.insert\(/);
  });

  it('asserts practice_id on the target — a memberId alone is not authority', () => {
    expect(codeOf(body)).toMatch(/\.eq\('practice_id', input\.practiceId\)/);
  });

  it('refuses a row that already has a login, and re-asserts it at write time', () => {
    expect(body).toMatch(/already has a login/);
    // The read is a separate statement, so the write must re-check.
    expect(codeOf(body)).toMatch(/\.is\('user_id', null\)/);
  });

  it('refuses a non-provider row', () => {
    expect(body).toMatch(/role !== 'provider'/);
  });

  it('clears the local names so the name has exactly one home', () => {
    const code = codeOf(body);
    expect(code).toMatch(/provider_first_name:\s*null/);
    expect(code).toMatch(/provider_last_name:\s*null/);
  });

  it('logs loudly if the invite succeeds but the link fails', () => {
    expect(body).toMatch(/INVITE SUCCEEDED but linking FAILED/);
  });

  it('sends the provider to /provider/setup, not the practice dashboard', () => {
    expect(body).toMatch(/\/provider\/setup/);
    expect(body).toMatch(/role:\s*'practice_provider'/);
  });
});

// ─── REGRESSION: the admin-staff invite path is untouched ───────────────

describe('REGRESSION — admin-staff invite is unchanged', () => {
  it('inviteMemberIntoPractice still exists with the same signature and insert', () => {
    expect(INVITE).toMatch(/export async function inviteMemberIntoPractice\(input: InviteMemberInput\)/);
    const body = INVITE.slice(
      INVITE.indexOf('export async function inviteMemberIntoPractice'),
      INVITE.indexOf('export async function inviteLoginForRosterMember'),
    );
    expect(body).toMatch(/inviteUserByEmail/);
    expect(body).toMatch(/\.from\('practice_members'\)\s*\n\s*\.insert\(memberRow\)/);
    expect(body).toMatch(/memberRole:\s+'provider' \| 'manager'|isProvider/);
  });

  it('addMember still requires SA ID and still delegates to that helper', () => {
    const body = bodyOf(ACTIONS, 'addMember');
    expect(body).toMatch(/validateSaId\(input\.saIdNumber\)/);
    expect(body).toMatch(/inviteMemberIntoPractice\(\{/);
    expect(body).toMatch(/canCreateBills:\s+input\.canCreateBills/);
    expect(body).toMatch(/canManagePractice:\s+input\.canManagePractice/);
  });

  it('the capability model is intact — both flags are still settable', () => {
    expect(ACTIONS).toMatch(/can_create_bills\?:\s+boolean/);
    expect(ACTIONS).toMatch(/can_manage_practice\?:\s+boolean/);
    // And the last-manager guardrail still guards.
    expect(ACTIONS).toMatch(/Cannot remove the last practice manager/);
  });

  it('guardManager is unchanged — can_manage_practice, no brand path', () => {
    const guard = ACTIONS.slice(
      ACTIONS.indexOf('async function guardManager'),
      ACTIONS.indexOf('// ─── Action 1'),
    );
    expect(guard).toMatch(/\.eq\('user_id', user\.id\)/);
    expect(guard).toMatch(/!membership\.can_manage_practice/);
    expect(guard).not.toMatch(/practice_group_members/);
  });

  it('AddMemberForm still collects an email and still has its role picker', () => {
    expect(ADD_FORM).toMatch(/email/i);
    // Not converted into the login-less form, and not given a mode switch.
    expect(codeOf(ADD_FORM)).not.toMatch(/addProviderToRoster|provider_first_name/);
  });

  it('MembersView still mounts AddMemberForm for the invite flow', () => {
    expect(VIEW).toMatch(/<AddMemberForm/);
    expect(VIEW).toMatch(/addMember\(input\)/);
  });
});

// ─── The two flows are distinct on the Team screen ──────────────────────

describe('the Team screen offers both, separately', () => {
  it('has an "Add practitioner" action distinct from "Invite team member"', () => {
    expect(VIEW).toMatch(/\+ Add practitioner/);
    expect(VIEW).toMatch(/\+ Invite team member/);
    expect(VIEW).toMatch(/data-testid="add-provider-toggle"/);
  });

  it('the roster form collects only name, specialty and HPCSA', () => {
    expect(ADD_PROV).toMatch(/First name/);
    expect(ADD_PROV).toMatch(/Last name/);
    expect(ADD_PROV).toMatch(/Specialty/);
    expect(ADD_PROV).toMatch(/HPCSA number/);
    // No email INPUT of any kind. The visible copy does mention email — it
    // says none is needed — so this asserts on the form's fields, not on the
    // absence of the word.
    expect(ADD_PROV).not.toMatch(/type="email"/);
    expect(ADD_PROV).not.toMatch(/email:/);                       // not in the draft type
    expect(ADD_PROV).not.toMatch(/aria-label="[^"]*[Ee]mail/);    // not a labelled field
    expect(ADD_PROV).not.toMatch(/set\('email'/);                 // not in the draft state
  });

  it('the roster form reuses the shared specialty vocabulary', () => {
    // One list, so the two surfaces cannot offer different specialties.
    // It reaches every dropdown through <SpecialtyOptions>, which reads
    // lib/specialties.ts — no form declares its own list.
    expect(ADD_PROV).toMatch(/from '@\/components\/SpecialtyOptions'/);
    expect(ADD_PROV).toMatch(/<SpecialtyOptions/);
    expect(ADD_PROV).not.toMatch(/const SPECIALTIES = \[/);
  });

  it('the roster form says plainly that no login is created', () => {
    expect(ADD_PROV).toMatch(/data-testid="add-provider-no-login-note"/);
    expect(ADD_PROV).toMatch(/No email address/i);
  });

  it('a roster row is chipped "No login" and offers "Give login"', () => {
    expect(VIEW).toMatch(/data-testid="member-no-login-chip"/);
    expect(VIEW).toMatch(/No login/);
    expect(VIEW).toMatch(/data-testid="invite-login-toggle"/);
    expect(VIEW).toMatch(/Give login/);
  });

  it('"Give login" appears ONLY for a login-less active row, and only to a manager', () => {
    expect(VIEW).toMatch(/isManager && rosterOnly && m\.active && !isEditing/);
  });

  it('the invite-login form states the scope of what the login grants', () => {
    expect(INV_LOGIN).toMatch(/data-testid="invite-login-scope-note"/);
    expect(INV_LOGIN).toMatch(/their own bills/i);
    expect(INV_LOGIN).toMatch(/Banking, team and practice\s*settings stay with you/);
  });

  it('the page selects the roster name columns, or names would render blank', () => {
    expect(PAGE).toMatch(/provider_first_name, provider_last_name/);
  });
});

// ─── The provider's own view ─────────────────────────────────────────────

describe('a provider\'s scoped view — informational, never money', () => {
  it('every plan read is scoped to the signed-in provider', () => {
    // Counted over CODE only: the scoping rationale is written in a comment
    // that quotes the filter, which would otherwise inflate the tally and let
    // an unscoped query slip through behind a well-documented one.
    const code  = codeOf(PROVIDER);
    const reads = code.match(/\.from\('plans'\)/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    // As many membership-scoped filters as plans reads: none is unscoped.
    // The filter shape changed with 0094 — attribution is by practice_members
    // row now, so "mine" is resolved to the caller's own ACTIVE memberships
    // first and every read is .in('provider_member_id', …) over that list.
    const scoped = code.match(/\.in\('provider_member_id', myActiveMemberIds\)/g) ?? [];
    expect(scoped.length).toBe(reads.length);
    // The old auth-user-keyed filter must not linger anywhere: it would now
    // read a DEPRECATED column and silently return nothing.
    expect(code).not.toMatch(/\.eq\('provider_id', user\.id\)/);
  });

  it('has NO practice-wide read and no practiceId parameter to tamper with', () => {
    const code = codeOf(PROVIDER);
    expect(code).not.toMatch(/practiceId|practice_id/);
    expect(code).not.toMatch(/searchParams/);
  });

  it('requires an ACTIVE membership — a disabled provider loses access', () => {
    expect(PROVIDER).toMatch(/\.from\('practice_members'\)/);
    expect(PROVIDER).toMatch(/\.eq\('active', true\)/);
    expect(PROVIDER).toMatch(/myActiveMemberIds\.length === 0\) redirect/);
    // ...and the id list the plan reads are scoped to is the active-filtered
    // one, so revocation is structural rather than a separate gate that a
    // later refactor could drop while leaving the reads in place.
    expect(codeOf(PROVIDER)).toMatch(
      /\.eq\('user_id', user\.id\)[\s\S]{0,40}?\.eq\('active', true\)/);
  });

  it('reads no payouts and shows no per-provider money figure', () => {
    const code = codeOf(PROVIDER);
    expect(code).not.toMatch(/payouts/);
    expect(code).not.toMatch(/net_amount/);
    expect(code).not.toMatch(/Paid to your practice|Owed to your practice/);
    expect(code).not.toMatch(/totalPaidOut|pendingPayout/);
    // And no "Payout" column header.
    expect(code).not.toMatch(/'Payout'/);
  });

  it('still shows the informational things: bill count, patient, amount, status', () => {
    expect(PROVIDER).toMatch(/Total bills/);
    expect(PROVIDER).toMatch(/patientDisplay/);
    expect(PROVIDER).toMatch(/StatusBadge/);
    expect(PROVIDER).toMatch(/'Reference', 'Patient', 'Amount', 'Status', 'Date'/);
  });

  it('the layout exposes no banking, team or settings route', () => {
    const code = codeOf(PROV_LAY);
    for (const forbidden of [/banking/i, /\/practice\/members/, /\/practice\/details/, /team/i, /settings/i]) {
      expect(code, `provider nav must not link ${forbidden}`).not.toMatch(forbidden);
    }
    // Exactly two links.
    expect(code).toMatch(/'\/provider',\s*label: 'Dashboard'/);
    expect(code).toMatch(/'\/provider\/profile', label: 'My profile'/);
  });

  it('the layout still redirects every non-provider role away', () => {
    expect(PROV_LAY).toMatch(/profile\?\.role !== 'practice_provider'/);
    expect(PROV_LAY).toMatch(/redirect\('\/practice'\)/);
  });
});

// ─── Migration posture ──────────────────────────────────────────────────

describe('migration 0091 is additive', () => {
  it('adds only the two name columns, a CHECK and an index', () => {
    expect(MIG).toMatch(/ADD COLUMN IF NOT EXISTS provider_first_name TEXT/);
    expect(MIG).toMatch(/ADD COLUMN IF NOT EXISTS provider_last_name\s+TEXT/);
    expect(MIG).toMatch(/ADD CONSTRAINT practice_members_identifiable/);
    expect(MIG).toMatch(/CREATE INDEX IF NOT EXISTS practice_members_roster_idx/);
  });

  it('drops nothing and migrates no data', () => {
    const sql = MIG.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|ALTER COLUMN|TRUNCATE|DELETE FROM/i);
    expect(sql).not.toMatch(/\bUPDATE\s+practice_members\b/i);
    expect(sql).not.toMatch(/\bINSERT INTO\b/i);
    // The only DROP is the idempotent re-add of its own constraint.
    const drops = sql.match(/DROP CONSTRAINT[^\n]*/g) ?? [];
    expect(drops).toEqual(['DROP CONSTRAINT IF EXISTS practice_members_identifiable;']);
  });

  it('does not touch any RLS policy', () => {
    const sql = MIG.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/CREATE POLICY|DROP POLICY|ENABLE ROW LEVEL SECURITY/i);
  });
});
