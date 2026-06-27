'use server';

import { revalidatePath } from 'next/cache';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

// ─── Platform-admin actions for practice groups (brand layer) ──────────
//
// Mirrors app/admin/practices/actions.ts in posture:
//   • guardAdmin via session client → sole authz gate.
//   • service-role client for writes (so 0054 column locks are bypassed
//     where appropriate AND RLS doesn't gatekeep on group_id changes).
//   • Each action takes one shape's worth of fields, returns { error }.

type GuardOk  = { ok: true; userId: string };
type GuardErr = { ok: false; error: string };

async function guardAdmin(): Promise<GuardOk | GuardErr> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') return { ok: false, error: 'Unauthorized.' };
  return { ok: true, userId: user.id };
}

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

// ─── createGroup ───────────────────────────────────────────────────────

export type CreateGroupInput = {
  name:                string;
  logoUrl?:            string | null;
  bankName?:           string | null;
  bankAccountNumber?:  string | null;
  branchCode?:         string | null;
  accountHolder?:      string | null;
  accountType?:        'current' | 'savings' | null;
};

export async function createGroup(input: CreateGroupInput): Promise<{ groupId: string | null; error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { groupId: null, error: guard.error };

  if (!input.name.trim()) return { groupId: null, error: 'Group name is required.' };

  const { data, error } = await svc()
    .from('practice_groups')
    .insert({
      name:                input.name.trim(),
      logo_url:            input.logoUrl            ?? null,
      bank_name:           input.bankName           ?? null,
      bank_account_number: input.bankAccountNumber  ?? null,
      branch_code:         input.branchCode         ?? null,
      account_holder:      input.accountHolder      ?? null,
      account_type:        input.accountType        ?? null,
      created_by:          guard.userId,
    })
    .select('id')
    .single();

  if (error || !data) return { groupId: null, error: error?.message ?? 'Could not create group.' };

  revalidatePath('/admin/groups');
  return { groupId: data.id as string, error: null };
}

// ─── updateGroupBanking ────────────────────────────────────────────────
//
// Lets the platform-admin set or clear the group's central banking.
// Branches that have no own banking fall back to this row at
// resolvePayoutBanking time.

export type UpdateGroupBankingInput = {
  groupId:             string;
  bankName:            string | null;
  bankAccountNumber:   string | null;
  branchCode:          string | null;
  accountHolder:       string | null;
  accountType:         'current' | 'savings' | null;
};

export async function updateGroupBanking(input: UpdateGroupBankingInput): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const { error } = await svc()
    .from('practice_groups')
    .update({
      bank_name:           input.bankName,
      bank_account_number: input.bankAccountNumber,
      branch_code:         input.branchCode,
      account_holder:      input.accountHolder,
      account_type:        input.accountType,
    })
    .eq('id', input.groupId);

  if (error) return { error: error.message };

  revalidatePath(`/admin/groups/${input.groupId}`);
  return { error: null };
}

// ─── assignPracticeToGroup / unassignPracticeFromGroup ─────────────────
//
// Sets / clears practices.group_id. This is the ONLY way a standalone
// practice becomes a branch (and back). The 0054 lock doesn't gate
// group_id changes — it locks status/approved_at/approved_by/fee_percent,
// not group_id — so a platform-admin can move a practice into a group
// freely. Service-role write keeps it untouched by RLS.

export async function assignPracticeToGroup(practiceId: string, groupId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const { error } = await svc()
    .from('practices')
    .update({ group_id: groupId })
    .eq('id', practiceId);

  if (error) return { error: error.message };

  revalidatePath('/admin/groups');
  revalidatePath(`/admin/groups/${groupId}`);
  return { error: null };
}

export async function unassignPracticeFromGroup(practiceId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const { error } = await svc()
    .from('practices')
    .update({ group_id: null })
    .eq('id', practiceId);

  if (error) return { error: error.message };

  revalidatePath('/admin/groups');
  return { error: null };
}

// ─── grantBrandAdmin / revokeBrandAdmin ────────────────────────────────
//
// Adds / deactivates a user as brand-admin of a group. Used by the
// platform-admin to onboard the brand owner who'll then create branches.

export async function grantBrandAdmin(groupId: string, userId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  // Upsert so re-granting an existing-but-deactivated row reactivates it.
  const { error } = await svc()
    .from('practice_group_members')
    .upsert(
      { group_id: groupId, user_id: userId, role: 'brand_admin', active: true },
      { onConflict: 'group_id,user_id' },
    );

  if (error) return { error: error.message };

  revalidatePath(`/admin/groups/${groupId}`);
  return { error: null };
}

export async function revokeBrandAdmin(groupId: string, userId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const { error } = await svc()
    .from('practice_group_members')
    .update({ active: false })
    .eq('group_id', groupId)
    .eq('user_id', userId);

  if (error) return { error: error.message };

  revalidatePath(`/admin/groups/${groupId}`);
  return { error: null };
}
