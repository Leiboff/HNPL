'use server';

import { revalidatePath } from 'next/cache';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { recordAdminAction } from '@/app/admin/_lib/adminAudit';

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

  // After the write, uniquely in this file: there is no entity_id to record
  // against until the insert returns one. A creation that fails leaves
  // nothing behind to investigate, which is the case where "before" buys
  // nothing.
  await recordAdminAction({
    actorId:    guard.userId,
    entityType: 'practice_group',
    entityId:   data.id as string,
    action:     'group_created',
    payload:    { name: input.name.trim(), banking_supplied: !!input.bankAccountNumber },
  });

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

  // The brand-level fallback account: every branch with no banking of its
  // own settles here, so one edit can redirect a whole brand's money.
  // 0131's trigger records the from→to (with the account number reduced to a
  // last-4 and a digest); this row is the one that names the admin, because
  // the write below is service-role and auth.uid() is NULL inside the
  // trigger. Deliberately carries NO account number of its own.
  await recordAdminAction({
    actorId:    guard.userId,
    entityType: 'practice_group',
    entityId:   input.groupId,
    action:     'group_banking_changed',
    payload:    {
      bank_name:      input.bankName,
      branch_code:    input.branchCode,
      account_holder: input.accountHolder,
      account_type:   input.accountType,
      cleared:        input.bankAccountNumber === null,
    },
  });

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

// ─── assignPracticeToGroup ─────────────────────────────────────────────
//
// Moves a practice into a (different) brand. Post-0062 there are no
// standalone practices — every practice has a group_id NOT NULL — so
// this is a brand-to-brand reassignment, used by platform support
// only (no UI affordance; admin runs it via dev console / direct call
// when a customer asks to split or merge brands).
//
// The 0054 lock doesn't gate group_id (it locks status, approved_at,
// approved_by, fee_percent), so service-role can move a practice
// between brands freely.

export async function assignPracticeToGroup(practiceId: string, groupId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  // Moving a branch between brands moves which group's banking it falls back
  // to, and which brand admins can see it. No UI affordance, called by
  // platform support directly — which is exactly the kind of action that
  // needs to be in the record rather than in someone's memory.
  await recordAdminAction({
    actorId:    guard.userId,
    entityType: 'practice',
    entityId:   practiceId,
    action:     'practice_reassigned_to_group',
    payload:    { group_id: groupId },
  });

  const { error } = await svc()
    .from('practices')
    .update({ group_id: groupId })
    .eq('id', practiceId);

  if (error) return { error: error.message };

  revalidatePath('/admin/groups');
  revalidatePath(`/admin/groups/${groupId}`);
  return { error: null };
}

// ─── grantBrandAdmin / revokeBrandAdmin ────────────────────────────────
//
// Adds / deactivates a user as brand-admin of a group. Used by the
// platform-admin to onboard the brand owner who'll then create branches.

export async function grantBrandAdmin(groupId: string, userId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  // A brand admin can edit their branches' banking, which is why this is in
  // the log. No trigger covers it: practice_group_members is a membership
  // ROW appearing, not a column changing on an existing one.
  await recordAdminAction({
    actorId:    guard.userId,
    entityType: 'practice_group',
    entityId:   groupId,
    action:     'grant_brand_admin',
    payload:    { user_id: userId },
  });

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

  await recordAdminAction({
    actorId:    guard.userId,
    entityType: 'practice_group',
    entityId:   groupId,
    action:     'revoke_brand_admin',
    payload:    { user_id: userId },
  });

  const { error } = await svc()
    .from('practice_group_members')
    .update({ active: false })
    .eq('group_id', groupId)
    .eq('user_id', userId);

  if (error) return { error: error.message };

  revalidatePath(`/admin/groups/${groupId}`);
  return { error: null };
}
