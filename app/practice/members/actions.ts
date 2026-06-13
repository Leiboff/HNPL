'use server';

import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { encryptId } from '@/lib/idEncryption';
import { isValidEmail, validateSaId } from '@/lib/validation';

// ─── Shared types ─────────────────────────────────────────────────────────────

export type MemberUpdates = {
  can_create_bills?:        boolean;
  can_manage_practice?:     boolean;
  specialty?:               string | null;
  hpcsa_number?:            string | null;
  payout_destination?:      'practice' | 'provider';
  personal_bank_name?:      string | null;
  personal_account_holder?: string | null;
  personal_account_number?: string | null;
  personal_branch_code?:    string | null;
  personal_account_type?:   string | null;
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
  payoutDestination:      'practice' | 'provider';
  personalBankName?:      string;
  personalAccountHolder?: string;
  personalAccountNumber?: string;
  personalBranchCode?:    string;
  personalAccountType?:   string;
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

export async function addMember(input: NewMemberInput): Promise<ActionResult> {
  const guard = await guardManager();
  if (!guard.ok) return { error: guard.error };
  const { practiceId } = guard;

  const supabase = await createClient();

  // Validate
  if (!input.firstName.trim())  return { error: 'First name is required.' };
  if (!input.lastName.trim())   return { error: 'Last name is required.' };
  if (!isValidEmail(input.email)) return { error: 'Enter a valid email address.' };
  const saIdResult = validateSaId(input.saIdNumber);
  if (!saIdResult.valid) return { error: 'SA ID number is invalid — please check what was typed.' };
  if (input.memberRole === 'provider' && !input.specialty) return { error: 'Specialty is required for clinicians.' };

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Check if email already belongs to an active or disabled member of this practice
  const { data: existingProfile } = await svc
    .from('profiles')
    .select('id')
    .eq('email', input.email.trim().toLowerCase())
    .maybeSingle();

  if (existingProfile) {
    const { data: existingMember } = await supabase
      .from('practice_members')
      .select('id, active')
      .eq('practice_id', practiceId)
      .eq('user_id', existingProfile.id)
      .maybeSingle();

    if (existingMember) {
      return {
        error: `This email already belongs to ${existingMember.active ? 'an active' : 'a disabled'} member of this practice.`,
      };
    }
  }

  const isProvider    = input.memberRole === 'provider';
  const authRole      = isProvider ? 'practice_provider' : 'practice_admin';
  const encryptedSaId = encryptId(input.saIdNumber.trim());
  const appUrl        = process.env.NEXT_PUBLIC_APP_URL ?? '';

  try {
    const { data: inviteData, error: inviteErr } = await svc.auth.admin.inviteUserByEmail(
      input.email.trim().toLowerCase(),
      {
        redirectTo: `${appUrl}${isProvider ? '/provider/setup' : '/practice'}`,
        data: {
          role:                 authRole,
          first_name:           input.firstName.trim(),
          last_name:            input.lastName.trim(),
          sa_id_number:         encryptedSaId,
          hpcsa_number:         isProvider ? (input.hpcsaNumber?.trim() || null) : null,
          must_change_password: true,
        },
      },
    );

    if (inviteErr || !inviteData.user) {
      return { error: inviteErr?.message ?? 'Failed to send invitation.' };
    }

    const newUserId = inviteData.user.id;

    const memberRow: Record<string, unknown> = {
      practice_id:         practiceId,
      user_id:             newUserId,
      role:                isProvider ? 'provider' : 'admin',
      active:              true,
      can_create_bills:    input.canCreateBills,
      can_manage_practice: input.canManagePractice,
      sa_id_number:        encryptedSaId,
      specialty:           isProvider ? (input.specialty   || null) : null,
      hpcsa_number:        isProvider ? (input.hpcsaNumber?.trim() || null) : null,
      payout_destination:  isProvider ? input.payoutDestination : 'practice',
    };

    if (isProvider && input.payoutDestination === 'provider') {
      memberRow.personal_bank_name      = input.personalBankName       || null;
      memberRow.personal_account_holder = input.personalAccountHolder  || null;
      memberRow.personal_account_number = input.personalAccountNumber  || null;
      memberRow.personal_branch_code    = input.personalBranchCode     || null;
      memberRow.personal_account_type   = input.personalAccountType    || null;
    }

    const { error: memberErr } = await svc.from('practice_members').insert(memberRow);

    if (memberErr) {
      // Invite succeeded but membership insert failed — log clearly for manual recovery
      console.error(
        '[addMember] INVITE SUCCEEDED but practice_members insert FAILED.',
        'userId:', newUserId, 'email:', input.email,
        'error:', memberErr.message,
      );
      return { error: `Invitation sent but failed to create membership record: ${memberErr.message}` };
    }

    return { error: null };

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
    return { error: msg };
  }
}
