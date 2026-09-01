// ─── NOT a 'use server' module. That is the point. ─────────────────────
//
// THE DEFECT (audit 2026-09-01, F-08)
//
// This file used to open with `'use server'`, and its own header said:
//
//     "The helper is GUARD-AGNOSTIC — the caller does all authz work
//      BEFORE calling here."
//
// That is a perfectly good contract for a plain module and an unsafe one
// for a server-action module, because EVERY export of a 'use server' file
// is an independently addressable HTTP endpoint. So
// inviteMemberIntoPractice — which takes practiceId as a parameter,
// performs no authorization of its own, and inserts a practice_members row
// with whatever capability flags it is handed — was callable without the
// guard that was supposed to precede it. Reaching it meant becoming a
// manager of any practice: issue bills, read patient plans, set the till
// PIN, register a till.
//
// Action ids are build-time hashes rather than guessable names, so this was
// not trivially reachable — but an id is not an authorization boundary, and
// the Next version this shipped on carries an advisory for unauthenticated
// disclosure of internal Server Function endpoints.
//
// Dropping the directive makes the contract true: these are ordinary server
// functions, reachable only from server code, and the two guarded actions
// in app/practice/members/actions.ts and app/brand/actions.ts are the only
// doors. THE RULE, generally: no 'use server' module may export a function
// that does not authorize itself.

import { createClient as createServiceClient } from '@supabase/supabase-js';
import { encryptId } from '@/lib/idEncryption';
import { isValidEmail, validateSaId } from '@/lib/validation';
import { checkHpcsa, HPCSA_ERROR_MESSAGE } from '@/lib/validation/hpcsa';

// ─── Shared invite implementation ──────────────────────────────────────
//
// One implementation of the "invite a user by email + create their
// practice_members row" flow. Two callers today:
//   • app/practice/members/actions.ts addMember  — practice-admin
//     path. Guarded by guardManager(). Requires SA ID (existing
//     posture, unchanged).
//   • app/brand/actions.ts addDoctor            — brand-admin path.
//     Guarded by guardBrandAdminOfPractice(practiceId). SA ID is
//     optional at invite; the provider completes it at /provider/setup.
//
// The helper is GUARD-AGNOSTIC — the caller does all authz work
// BEFORE calling here. We accept `practiceId` as an explicit argument
// so a bug on the caller side cannot silently write to the wrong
// practice.
//
// Validation posture:
//   • Email    — required, isValidEmail
//   • First/last name — required, trimmed
//   • memberRole — 'provider' | 'manager'
//   • specialty — required if provider
//   • hpcsaNumber — optional; if supplied, must pass checkHpcsa shape
//   • saIdNumber — OPTIONAL. If supplied, must pass validateSaId; the
//     invite metadata carries the encrypted form so /provider/setup
//     can hydrate the profile. If NOT supplied, the invite still goes
//     out and the provider enters it themselves at setup.
//   • payout destination — NOT an input. Always 'practice'.
//   • capability flags (canCreateBills, canManagePractice) — default
//     to `false` when not supplied (brand-admin's flow doesn't hand
//     these out; practice-admin's form still passes them explicitly).
//
// Duplicate detection:
//   • Existing profile + existing membership row on THIS practice →
//     returns an error message differentiating active vs disabled.

// No payoutDestination / personal banking inputs: every payout goes to the
// practice's own bank account (see the insert below). Callers that used to
// pass them — the practice-admin add-member form — no longer collect them.
export type InviteMemberInput = {
  practiceId:              string;
  memberRole:              'provider' | 'manager';
  firstName:               string;
  lastName:                string;
  email:                   string;
  saIdNumber?:             string | null;
  canCreateBills?:         boolean;
  canManagePractice?:      boolean;
  specialty?:              string | null;
  hpcsaNumber?:            string | null;
};

export type InviteMemberResult = {
  memberId: string | null;
  userId:   string | null;
  error:    string | null;
};

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function inviteMemberIntoPractice(input: InviteMemberInput): Promise<InviteMemberResult> {
  // Validation — same rules regardless of caller.
  if (!input.firstName?.trim())   return { memberId: null, userId: null, error: 'First name is required.' };
  if (!input.lastName?.trim())    return { memberId: null, userId: null, error: 'Last name is required.' };
  if (!isValidEmail(input.email)) return { memberId: null, userId: null, error: 'Enter a valid email address.' };

  const isProvider = input.memberRole === 'provider';
  if (isProvider && !input.specialty?.trim()) {
    return { memberId: null, userId: null, error: 'Specialty is required for practitioners.' };
  }

  // HPCSA is optional at invite; if supplied it must be shape-valid.
  // This is the same posture as the practice-admin flow — polluting
  // the discovery grouping key with malformed HPCSA is worse than
  // deferring HPCSA entry to /provider/setup.
  const trimmedHpcsa = input.hpcsaNumber?.trim() || '';
  if (isProvider && trimmedHpcsa.length > 0) {
    const check = checkHpcsa(trimmedHpcsa);
    if (!check.ok) return { memberId: null, userId: null, error: HPCSA_ERROR_MESSAGE[check.reason] };
  }

  // SA ID is optional here. If supplied, it must validate; if not,
  // the invited provider fills it in at /provider/setup.
  let encryptedSaId: string | null = null;
  const rawSaId = input.saIdNumber?.trim() || '';
  if (rawSaId.length > 0) {
    const check = validateSaId(rawSaId);
    if (!check.valid) {
      return { memberId: null, userId: null, error: 'SA ID number is invalid — please check what was typed.' };
    }
    try {
      encryptedSaId = encryptId(rawSaId);
    } catch {
      return { memberId: null, userId: null, error: 'Encryption error — please contact support.' };
    }
  }

  const service = svc();
  const emailNorm = input.email.trim().toLowerCase();

  // Existing-member check — via service-role for the profiles read
  // (a stranger's profile isn't visible under RLS) and via session
  // client for the membership check (only rows on THIS practice
  // matter; RLS scopes correctly).
  const { data: existingProfile } = await service
    .from('profiles')
    .select('id')
    .eq('email', emailNorm)
    .maybeSingle();

  if (existingProfile) {
    // Use service-role for this check too — the caller might be a
    // brand-admin whose session-client view of practice_members on
    // this practice is limited. This is safe: we're only checking
    // for a duplicate on the practice we've already been authorised
    // for by the caller's guard.
    const { data: existingMember } = await service
      .from('practice_members')
      .select('id, active')
      .eq('practice_id', input.practiceId)
      .eq('user_id', existingProfile.id)
      .maybeSingle();

    if (existingMember) {
      return {
        memberId: null,
        userId:   null,
        error:    `This email already belongs to ${existingMember.active ? 'an active' : 'a disabled'} member of this practice.`,
      };
    }
  }

  const authRole = isProvider ? 'practice_provider' : 'practice_admin';
  const appUrl   = process.env.NEXT_PUBLIC_APP_URL ?? '';

  try {
    const { data: inviteData, error: inviteErr } = await service.auth.admin.inviteUserByEmail(
      emailNorm,
      {
        redirectTo: `${appUrl}${isProvider ? '/provider/setup' : '/practice'}`,
        data: {
          role:                 authRole,
          first_name:           input.firstName.trim(),
          last_name:            input.lastName.trim(),
          sa_id_number:         encryptedSaId,
          hpcsa_number:         isProvider ? (trimmedHpcsa || null) : null,
          must_change_password: true,
        },
      },
    );

    if (inviteErr || !inviteData?.user) {
      return { memberId: null, userId: null, error: inviteErr?.message ?? 'Failed to send invitation.' };
    }

    const newUserId = inviteData.user.id;

    // Default capability flags to `false` when the caller didn't
    // specify. The practice-admin's form always passes both; the
    // brand-admin's addDoctor uses defaults (a doctor doesn't get
    // manage-practice or bill-create powers by default).
    const memberRow: Record<string, unknown> = {
      practice_id:         input.practiceId,
      user_id:             newUserId,
      role:                isProvider ? 'provider' : 'admin',
      active:              true,
      can_create_bills:    input.canCreateBills    ?? false,
      can_manage_practice: input.canManagePractice ?? false,
      sa_id_number:        encryptedSaId,
      specialty:           isProvider ? (input.specialty?.trim() || null) : null,
      hpcsa_number:        isProvider ? (trimmedHpcsa || null) : null,
      // Always 'practice'. The old per-provider choice (pay a doctor to
      // their own snapshotted bank details) is removed: one practice = one
      // bank account = one deposit, which is what makes a weekly payout
      // batch reconcilable (migration 0090). Written explicitly rather than
      // relying on the column DEFAULT so the intent is visible at the
      // insert. The personal_bank_* columns are simply never populated.
      payout_destination:  'practice',
    };

    const { data: inserted, error: memberErr } = await service
      .from('practice_members')
      .insert(memberRow)
      .select('id')
      .single();

    if (memberErr || !inserted) {
      console.error(
        '[inviteMemberIntoPractice] INVITE SUCCEEDED but practice_members insert FAILED.',
        'userId:', newUserId, 'email:', emailNorm, 'practiceId:', input.practiceId,
        'error:', memberErr?.message,
      );
      return {
        memberId: null,
        userId:   newUserId,
        error:    `Invitation sent but failed to create membership record: ${memberErr?.message ?? 'unknown error'}`,
      };
    }

    return { memberId: inserted.id as string, userId: newUserId, error: null };

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
    return { memberId: null, userId: null, error: msg };
  }
}

// ─── Giving a ROSTER practitioner a login, later ────────────────────────
//
// A practitioner can be listed on a practice with just name + specialty +
// HPCSA and no auth account (migration 0091). This is the optional second
// step: the manager decides, per practitioner, that this one should be able
// to sign in and see their own bills.
//
// WHY THIS IS A SEPARATE FUNCTION AND NOT A FLAG ON THE ONE ABOVE
// ──────────────────────────────────────────────────────────────
// inviteMemberIntoPractice INSERTS a membership row. This one must UPDATE an
// existing one. Threading that through as a branch would have meant editing
// the function the admin-staff invite path depends on — a path explicitly out
// of scope — so it is left byte-identical and the differing behaviour lives
// here. What IS shared is everything that should be: svc(), isValidEmail,
// validateSaId, encryptId, and the same inviteUserByEmail ceremony.
//
// WHY LINK RATHER THAN INSERT
// ───────────────────────────
// Inserting a second row would split one practitioner's identity in two: the
// roster row keeps the specialty and HPCSA, the new row gets the login, and
// the Team screen shows the same person twice. Worse, a bill already
// attributed to the roster row belongs to neither. So the roster row IS the
// practitioner and gains a user_id; nothing about it is duplicated or moved.
//
// The name then MOVES to profiles, because 0091's check constraint requires
// exactly one home for it: a row with user_id set must have both local name
// columns NULL. That is deliberate — a person with an account has one
// canonical name, and a stale copy on the membership row is how "why does it
// still say her maiden name" happens.

export type InviteLoginInput = {
  practiceId: string;
  /** The EXISTING practice_members row to link. Must be login-less. */
  memberId:   string;
  email:      string;
};

export type InviteLoginResult = {
  userId: string | null;
  error:  string | null;
};

export async function inviteLoginForRosterMember(
  input: InviteLoginInput,
): Promise<InviteLoginResult> {
  if (!isValidEmail(input.email)) return { userId: null, error: 'Enter a valid email address.' };

  const service   = svc();
  const emailNorm = input.email.trim().toLowerCase();

  // ── The target must be a login-less row ON THIS PRACTICE ──────────────
  //
  // practice_id is asserted here rather than trusted from the caller's
  // memberId: the guard authorised a practice, not a row, so without this a
  // manager could pass any practice's member id and attach a login they
  // control to someone else's roster.
  const { data: member } = await service
    .from('practice_members')
    .select('id, practice_id, user_id, role, provider_first_name, provider_last_name, specialty, hpcsa_number')
    .eq('id', input.memberId)
    .eq('practice_id', input.practiceId)
    .maybeSingle();

  if (!member)                return { userId: null, error: 'Practitioner not found on this practice.' };
  if (member.user_id)         return { userId: null, error: 'This practitioner already has a login.' };
  if (member.role !== 'provider') {
    return { userId: null, error: 'Only practitioners can be given a login this way.' };
  }

  const firstName = (member.provider_first_name as string | null)?.trim() || '';
  const lastName  = (member.provider_last_name  as string | null)?.trim() || '';
  if (!firstName || !lastName) {
    // Unreachable while 0091's constraint holds; asserted rather than assumed
    // because the invite metadata below cannot be built without a name.
    return { userId: null, error: 'This roster entry has no name recorded — edit it before inviting.' };
  }

  // ── Duplicate detection, same posture as inviteMemberIntoPractice ─────
  const { data: existingProfile } = await service
    .from('profiles')
    .select('id')
    .eq('email', emailNorm)
    .maybeSingle();

  if (existingProfile) {
    const { data: existingMember } = await service
      .from('practice_members')
      .select('id, active')
      .eq('practice_id', input.practiceId)
      .eq('user_id', existingProfile.id)
      .maybeSingle();

    if (existingMember) {
      return {
        userId: null,
        error: `This email already belongs to ${existingMember.active ? 'an active' : 'a disabled'} member of this practice.`,
      };
    }

    // A real person with an existing BetterNow account who is not yet on this
    // practice. Link, don't invite: they already have a password, and
    // inviteUserByEmail would fail on the duplicate address anyway. Refused
    // rather than guessed — silently attaching an existing stranger's account
    // to a practice roster is not something a typo should be able to do.
    return {
      userId: null,
      error: 'That email already has a BetterNow account. Use a different address, or ask support to link the existing account.',
    };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';

  try {
    const { data: inviteData, error: inviteErr } = await service.auth.admin.inviteUserByEmail(
      emailNorm,
      {
        redirectTo: `${appUrl}/provider/setup`,
        data: {
          role:                 'practice_provider',
          first_name:           firstName,
          last_name:            lastName,
          // No SA ID: a roster entry never had one to record. The provider
          // supplies it themselves at /provider/setup, which is the same
          // deferral the brand-admin invite path already relies on.
          sa_id_number:         null,
          hpcsa_number:         (member.hpcsa_number as string | null) ?? null,
          must_change_password: true,
        },
      },
    );

    if (inviteErr || !inviteData?.user) {
      return { userId: null, error: inviteErr?.message ?? 'Failed to send invitation.' };
    }

    const newUserId = inviteData.user.id;

    // ── Link the EXISTING row ─────────────────────────────────────────────
    //
    // `.is('user_id', null)` is re-asserted at write time: the read above is
    // a separate statement, so a concurrent invite could have linked this row
    // in between. Losing that race must leave the first link intact rather
    // than overwrite it with a second account.
    const { data: linked, error: linkErr } = await service
      .from('practice_members')
      .update({
        user_id:             newUserId,
        // Name moves to profiles — 0091's constraint requires exactly one home.
        provider_first_name: null,
        provider_last_name:  null,
      })
      .eq('id', input.memberId)
      .eq('practice_id', input.practiceId)
      .is('user_id', null)
      .select('id');

    if (linkErr || (linked ?? []).length === 0) {
      // The invite went out but the row is unlinked, so the practitioner
      // would sign in with no membership. Logged loudly with everything
      // needed to reconcile by hand, exactly as inviteMemberIntoPractice
      // does for its own half-completed case.
      console.error(
        '[inviteLoginForRosterMember] INVITE SUCCEEDED but linking FAILED.',
        'userId:', newUserId, 'email:', emailNorm,
        'memberId:', input.memberId, 'practiceId:', input.practiceId,
        'error:', linkErr?.message ?? 'row no longer login-less',
      );
      return {
        userId: newUserId,
        error: `Invitation sent but linking it to the roster entry failed: ${linkErr?.message ?? 'the entry already has a login'}`,
      };
    }

    return { userId: newUserId, error: null };

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
    return { userId: null, error: msg };
  }
}
