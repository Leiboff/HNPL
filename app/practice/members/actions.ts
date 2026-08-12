'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { encryptId } from '@/lib/idEncryption';
import { validateSaId } from '@/lib/validation';
import { checkHpcsa, HPCSA_ERROR_MESSAGE } from '@/lib/validation/hpcsa';
import { inviteMemberIntoPractice, inviteLoginForRosterMember } from '@/lib/brand/inviteMember';

// ─── Shared types ─────────────────────────────────────────────────────────────

// NOTE — no payout_destination, no personal_bank_* fields.
//
// Payouts always go to the PRACTICE's bank account: one practice = one bank
// account = one deposit, which is what makes a weekly payout batch
// reconcilable against a bank statement (migration 0090). These fields used
// to be settable per membership, which also meant one doctor at two branches
// could carry two different destinations with nothing noticing.
//
// The COLUMNS still exist on practice_members and are intentionally left
// alone — historical payouts rows snapshotted them and must stay auditable.
// Removing them from these input types is what makes the columns
// unreachable-by-write from the app, without a destructive migration.
export type MemberUpdates = {
  can_create_bills?:        boolean;
  can_manage_practice?:     boolean;
  specialty?:               string | null;
  hpcsa_number?:            string | null;
};

export type NewMemberInput = {
  memberRole:             'provider' | 'manager';
  firstName:              string;
  lastName:               string;
  email:                  string;
  saIdNumber:             string;
  canCreateBills:         boolean;
  canManagePractice:      boolean;
  specialty?:             string;
  hpcsaNumber?:           string;
};

type ActionResult = { error: string | null };

// ─── Guard helper ─────────────────────────────────────────────────────────────

type GuardOk = { ok: true;  userId: string; practiceId: string };
type GuardErr = { ok: false; error: string };

async function guardManager(): Promise<GuardOk | GuardErr> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  const { data: membership } = await supabase
    .from('practice_members')
    .select('practice_id, can_manage_practice')
    .eq('user_id', user.id)
    .eq('active', true)
    .single();

  if (!membership)                    return { ok: false, error: 'No active membership.' };
  if (!membership.can_manage_practice) return { ok: false, error: 'You do not have permission to manage this practice.' };

  return { ok: true, userId: user.id, practiceId: membership.practice_id as string };
}

// ─── Action 1: updateMember ───────────────────────────────────────────────────

export async function updateMember(
  memberId: string,
  updates:  MemberUpdates,
): Promise<ActionResult> {
  const guard = await guardManager();
  if (!guard.ok) return { error: guard.error };
  const { practiceId } = guard;

  const supabase = await createClient();

  // Verify target belongs to this practice
  const { data: target } = await supabase
    .from('practice_members')
    .select('id, practice_id, can_manage_practice')
    .eq('id', memberId)
    .single();

  if (!target || (target.practice_id as string) !== practiceId) {
    return { error: 'Member not found in your practice.' };
  }

  // Last manager guardrail
  if (updates.can_manage_practice === false && target.can_manage_practice) {
    const { count } = await supabase
      .from('practice_members')
      .select('*', { count: 'exact', head: true })
      .eq('practice_id', practiceId)
      .eq('active', true)
      .eq('can_manage_practice', true)
      .neq('id', memberId);

    if ((count ?? 0) === 0) {
      return {
        error: 'Cannot remove the last practice manager. Transfer management rights to another member first.',
      };
    }
  }

  const { error } = await supabase
    .from('practice_members')
    .update(updates)
    .eq('id', memberId)
    .eq('practice_id', practiceId);

  if (error) return { error: error.message };
  return { error: null };
}

// ─── Action 2: disableMember ──────────────────────────────────────────────────

export async function disableMember(memberId: string): Promise<ActionResult> {
  const guard = await guardManager();
  if (!guard.ok) return { error: guard.error };
  const { userId, practiceId } = guard;

  const supabase = await createClient();

  const { data: target } = await supabase
    .from('practice_members')
    .select('id, user_id, practice_id, can_manage_practice')
    .eq('id', memberId)
    .single();

  if (!target || (target.practice_id as string) !== practiceId) {
    return { error: 'Member not found in your practice.' };
  }

  if ((target.user_id as string) === userId) {
    return { error: 'You cannot disable your own account. Ask another manager.' };
  }

  // Last manager guardrail
  if (target.can_manage_practice) {
    const { count } = await supabase
      .from('practice_members')
      .select('*', { count: 'exact', head: true })
      .eq('practice_id', practiceId)
      .eq('active', true)
      .eq('can_manage_practice', true)
      .neq('id', memberId);

    if ((count ?? 0) === 0) {
      return { error: 'Cannot disable the last practice manager.' };
    }
  }

  const { error } = await supabase
    .from('practice_members')
    .update({ active: false })
    .eq('id', memberId)
    .eq('practice_id', practiceId);

  if (error) return { error: error.message };
  return { error: null };
}

// ─── Action 3: enableMember ───────────────────────────────────────────────────

export async function enableMember(memberId: string): Promise<ActionResult> {
  const guard = await guardManager();
  if (!guard.ok) return { error: guard.error };
  const { practiceId } = guard;

  const supabase = await createClient();

  const { data: target } = await supabase
    .from('practice_members')
    .select('id, practice_id')
    .eq('id', memberId)
    .single();

  if (!target || (target.practice_id as string) !== practiceId) {
    return { error: 'Member not found in your practice.' };
  }

  const { error } = await supabase
    .from('practice_members')
    .update({ active: true })
    .eq('id', memberId)
    .eq('practice_id', practiceId);

  if (error) return { error: error.message };
  return { error: null };
}

// ─── Action 4: addMember ──────────────────────────────────────────────────────

// The practice-admin path for inviting a new member into their own
// practice. Guards via guardManager() (must have can_manage_practice
// on their active membership) and delegates the invite mechanics to
// the shared inviteMemberIntoPractice helper. The practice-admin form
// requires SA ID (existing posture, unchanged) so we validate it here
// BEFORE calling the helper — the helper accepts SA ID as optional
// because the brand-admin path defers ID capture to /provider/setup.

export async function addMember(input: NewMemberInput): Promise<ActionResult> {
  const guard = await guardManager();
  if (!guard.ok) return { error: guard.error };
  const { practiceId } = guard;

  // Practice-admin path: SA ID is required here (has always been).
  // The shared helper treats SA ID as optional, so we validate the
  // required-ness at this caller layer before delegating.
  const saIdResult = validateSaId(input.saIdNumber);
  if (!saIdResult.valid) return { error: 'SA ID number is invalid — please check what was typed.' };

  const result = await inviteMemberIntoPractice({
    practiceId,
    memberRole:             input.memberRole,
    firstName:              input.firstName,
    lastName:               input.lastName,
    email:                  input.email,
    saIdNumber:             input.saIdNumber,
    canCreateBills:         input.canCreateBills,
    canManagePractice:      input.canManagePractice,
    specialty:              input.specialty,
    hpcsaNumber:            input.hpcsaNumber,
    // No payout destination or personal banking — see the note on
    // NewMemberInput. inviteMemberIntoPractice defaults the column to
    // 'practice' when it isn't supplied.
  });

  if (result.error) return { error: result.error };

  revalidatePath('/practice/members');
  return { error: null };
}


// ─── Action 5: becomeProvider (self-elect) ───────────────────────────────────
//
// Solo-practitioner path: signup creates the admin's practice_members
// row with role='admin', no clinical fields. When the admin is also the
// clinician (a single dentist's practice, for example), they self-elect
// here. We UPDATE their existing row in place — no new row — so:
//
//   • UNIQUE (practice_id, user_id) is preserved (no duplicate identity).
//   • Their capability flags (can_manage_practice, can_create_bills) are
//     kept unchanged — they continue to manage the practice.
//   • role flips 'admin' → 'provider' so the trading gate's strict
//     eq('role','provider') match counts them. is_practice_manager()
//     ([0034]) reads can_manage_practice not role, so admin powers
//     survive the role transition. is_practice_admin() ([0002]) IS
//     defined but unused in policies since [0035] — dead code, no
//     effect on permissions.
//
// SA ID is encrypted via the existing idEncryption.encryptId, same
// path addMember uses for invited providers.

export type BecomeProviderInput = {
  specialty:    string;
  hpcsaNumber:  string;
  saIdNumber:   string;
};

export async function becomeProvider(input: BecomeProviderInput): Promise<ActionResult> {
  const guard = await guardManager();
  if (!guard.ok) return { error: guard.error };
  const { userId, practiceId } = guard;

  // Validate inputs server-side (authoritative). Specialty + HPCSA must
  // be present; SA ID must pass the full validator.
  const specialty = input.specialty.trim();
  if (!specialty) return { error: 'Specialty is required.' };

  const hpcsa = input.hpcsaNumber.trim();
  const hpcsaCheck = checkHpcsa(hpcsa);
  if (!hpcsaCheck.ok) return { error: HPCSA_ERROR_MESSAGE[hpcsaCheck.reason] };

  const saIdResult = validateSaId(input.saIdNumber);
  if (!saIdResult.valid) {
    return { error: 'SA ID number is invalid — please check what was typed.' };
  }

  const supabase = await createClient();

  // Verify the caller's current row exists and they aren't ALREADY a
  // provider (idempotency / defensive — the UI hides the form when role
  // is already 'provider', but a stale tab might re-submit).
  const { data: ownRow } = await supabase
    .from('practice_members')
    .select('id, role')
    .eq('practice_id', practiceId)
    .eq('user_id', userId)
    .single();

  if (!ownRow) return { error: 'Your membership record was not found.' };
  if (ownRow.role === 'provider') return { error: 'You are already a provider on this practice.' };

  let encryptedSaId: string;
  try {
    encryptedSaId = encryptId(input.saIdNumber.trim());
  } catch {
    return { error: 'Encryption error — please contact support.' };
  }

  const { error } = await supabase
    .from('practice_members')
    .update({
      role:             'provider',
      specialty,
      hpcsa_number:     hpcsa,
      sa_id_number:     encryptedSaId,
      // Capability flags intentionally NOT touched — preserve admin powers.
    })
    .eq('id', ownRow.id)
    .eq('practice_id', practiceId);

  if (error) return { error: error.message };

  revalidatePath('/practice/members');
  revalidatePath('/practice');
  return { error: null };
}


// ─── Action 6: addProviderToRoster ───────────────────────────────────────────
//
// Add a practitioner to the roster with NO login and NO invite email: name,
// specialty, HPCSA number. Most clinicians never sign in — the manager does
// the billing — so requiring an auth account per clinician made "add the
// third dentist" an email ceremony with a mailbox to chase.
//
// This is a SEPARATE action from addMember rather than a mode of it, and
// deliberately so:
//
//   • addMember/inviteMemberIntoPractice is the admin-staff and
//     invited-provider path. It is untouched by this work — same guard, same
//     validation, same insert. A shared function with an `email?` branch
//     would have put the two flows one typo apart, and the one that sends
//     email to a stranger is the one you least want a typo in.
//   • The inputs genuinely differ. No email, and no SA ID: SA ID exists for
//     the identity ceremony a person completes at /provider/setup, and a
//     roster entry has nobody to complete it. HPCSA is REQUIRED here (it is
//     optional at invite, where /provider/setup can chase it) — with no
//     login there is no later chance to collect it, and an unverifiable
//     practitioner on a billing roster is worth refusing at the door.
//
// The row grants nothing. Every authority helper resolves through
// `user_id = auth.uid()` (is_practice_member / is_practice_manager), so a
// NULL user_id matches none of them. See migration 0091.

export type RosterProviderInput = {
  firstName:   string;
  lastName:    string;
  specialty:   string;
  hpcsaNumber: string;
};

export async function addProviderToRoster(input: RosterProviderInput): Promise<ActionResult> {
  const guard = await guardManager();
  if (!guard.ok) return { error: guard.error };
  const { practiceId } = guard;

  const firstName = input.firstName?.trim() ?? '';
  const lastName  = input.lastName?.trim()  ?? '';
  const specialty = input.specialty?.trim() ?? '';
  const hpcsa     = input.hpcsaNumber?.trim() ?? '';

  if (!firstName) return { error: 'First name is required.' };
  if (!lastName)  return { error: 'Last name is required.' };
  if (!specialty) return { error: 'Specialty is required for practitioners.' };

  // Required here, unlike at invite — see the note above.
  const hpcsaCheck = checkHpcsa(hpcsa);
  if (!hpcsaCheck.ok) return { error: HPCSA_ERROR_MESSAGE[hpcsaCheck.reason] };

  const supabase = await createClient();

  // Same-name duplicate guard. Not a constraint, because two clinicians can
  // legitimately share a name and a UNIQUE would then be unfixable from the
  // UI — but a silent duplicate on a billing roster is worth one round-trip
  // to prevent, since the manager picking a provider on a bill would have no
  // way to tell the two apart.
  const { data: clash } = await supabase
    .from('practice_members')
    .select('id')
    .eq('practice_id', practiceId)
    .is('user_id', null)
    .ilike('provider_first_name', firstName)
    .ilike('provider_last_name',  lastName)
    .maybeSingle();

  if (clash) {
    return { error: `${firstName} ${lastName} is already on this practice's roster.` };
  }

  const { error } = await supabase
    .from('practice_members')
    .insert({
      practice_id:         practiceId,
      // No login. The whole point — and what makes this row authorise nothing.
      user_id:             null,
      provider_first_name: firstName,
      provider_last_name:  lastName,
      role:                'provider',
      active:              true,
      specialty,
      hpcsa_number:        hpcsa,
      // No capabilities. A roster row could not exercise them anyway (they
      // are read through user_id), but writing false is the honest record of
      // intent rather than relying on a column default.
      can_create_bills:    false,
      can_manage_practice: false,
      // Always the practice's account — one practice, one bank account, one
      // deposit (migration 0090). Stated at the insert, as inviteMember does.
      payout_destination:  'practice',
    });

  if (error) return { error: error.message };

  revalidatePath('/practice/members');
  // The trading gate counts active role='provider' rows, so adding the first
  // practitioner can unblock billing — the dashboard's gate panel has to
  // re-render for that to be visible.
  revalidatePath('/practice');
  return { error: null };
}


// ─── Action 7: inviteLoginForProvider ────────────────────────────────────────
//
// The optional second step: give a rostered practitioner a login later. The
// manager decides, per practitioner, and nothing about the roster entry
// forces or expects it.
//
// Delegates to lib/brand/inviteMember.ts inviteLoginForRosterMember, which
// LINKS the existing row rather than inserting a second one — see its header
// for why that matters (a second row would split one practitioner's identity
// in two, and their historical bills would stay on neither).

export async function inviteLoginForProvider(
  memberId: string,
  email:    string,
): Promise<ActionResult> {
  const guard = await guardManager();
  if (!guard.ok) return { error: guard.error };

  const result = await inviteLoginForRosterMember({
    practiceId: guard.practiceId,
    memberId,
    email,
  });

  if (result.error) return { error: result.error };

  revalidatePath('/practice/members');
  return { error: null };
}
