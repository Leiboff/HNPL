'use server';

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
