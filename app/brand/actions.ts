'use server';

import { revalidatePath } from 'next/cache';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { isWithinSouthAfrica } from '@/lib/maps/saBounds';

// ─── Brand-admin server actions ────────────────────────────────────────
//
// One action surface owned by brand-admins: createBranch (which
// creates a pending practice under a brand they admin). The action
// uses the service-role client for the INSERT because:
//   • RLS on practices has no permissive INSERT policy for non-owners
//     (a brand-admin is not the practice's owner_id at this point —
//     they're creating the practice ON BEHALF of the brand).
//   • The 0054 column-lock trigger fires only on UPDATE, not INSERT,
//     so a service-role INSERT with status='pending' is the correct
//     posture — the trigger then blocks any subsequent status change
//     from a non-service-role caller.
//
// Approval continues to flow through the existing platform-admin
// path (app/admin/practices/actions.ts approvePractice). Brand-admin
// never approves their own practice.
//
// Post-0062: every customer account is rooted at a brand. The solo
// signup flow creates a 1-practice brand silently and the brand is
// invisible at n=1; this action is what the brand-owner calls when
// they add their second (or third, ...) practice from /brand/new-practice.

type GuardOk  = { ok: true;  userId: string };
type GuardErr = { ok: false; error: string };

async function guardBrandAdmin(groupId: string): Promise<GuardOk | GuardErr> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  const { data: membership } = await supabase
    .from('practice_group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .eq('user_id', user.id)
    .eq('active', true)
    .maybeSingle();

  if (!membership) return { ok: false, error: 'Unauthorized.' };

  return { ok: true, userId: user.id };
}

// Resolve a practice's group_id (via service-role so the guard is
// not RLS-coupled to the caller's identity) and then verify the
// caller is an active brand_admin of that group. This is the
// canonical "may this brand-admin edit this branch" check; used by
// every per-branch edit action below.
async function guardBrandAdminOfPractice(practiceId: string): Promise<GuardOk | GuardErr> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  // Service-role read of practices.group_id — RLS on the table is
  // relationship-scoped so a brand-admin of group B wouldn't even be
  // able to RESOLVE group A's practice ids. The guard's job is to
  // resolve + check; using the session client here would silently
  // return null for any practice the caller can't already see,
  // which would conflate "wrong group" with "no such practice".
  const { data: practice } = await svc()
    .from('practices')
    .select('group_id')
    .eq('id', practiceId)
    .maybeSingle();

  if (!practice?.group_id) return { ok: false, error: 'Unauthorized.' };

  const { data: membership } = await supabase
    .from('practice_group_members')
    .select('user_id')
    .eq('group_id', practice.group_id as string)
    .eq('user_id', user.id)
    .eq('active', true)
    .maybeSingle();

  if (!membership) return { ok: false, error: 'Unauthorized.' };

  return { ok: true, userId: user.id };
}

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

// ─── createBranch ──────────────────────────────────────────────────────
//
// Brand-admin creates a new branch under their group. Branch is created
// pending — platform-admin must approve via the existing approval
// action before it can trade.

export type CreateBranchInput = {
  groupId:           string;
  name:              string;
  specialty:         string;
  email:             string;
  phone:             string | null;
  // Address payload from the Places (New) picker on the client.
  addressLine1:      string;
  addressLine2:      string | null;
  suburb:            string | null;
  city:              string | null;
  province:          string | null;
  postalCode:        string | null;
  latitude:          number | null;
  longitude:         number | null;
};

export async function createBranch(input: CreateBranchInput): Promise<{ branchId: string | null; error: string | null }> {
  const guard = await guardBrandAdmin(input.groupId);
  if (!guard.ok) return { branchId: null, error: guard.error };

  if (!input.name.trim() || !input.specialty.trim() || !input.email.trim() || !input.addressLine1.trim()) {
    return { branchId: null, error: 'Name, specialty, email, and address are required.' };
  }

  // SA-range backstop on the picker coords. Real Places ZA results
  // can't trip this; a tampered payload could.
  let lat: number | null = input.latitude;
  let lng: number | null = input.longitude;
  if (lat != null && lng != null && !isWithinSouthAfrica(lat, lng)) {
    lat = null;
    lng = null;
  }

  const client = svc();

  const { data: inserted, error } = await client
    .from('practices')
    .insert({
      owner_id:                     guard.userId,
      group_id:                     input.groupId,
      name:                         input.name.trim(),
      specialty:                    input.specialty,
      email:                        input.email.trim().toLowerCase(),
      phone:                        input.phone,
      address_line1:                input.addressLine1.trim(),
      address_line2:                input.addressLine2 ?? null,
      suburb:                       input.suburb       ?? null,
      city:                         input.city         ?? null,
      practice_province:            input.province     ?? null,
      postal_code:                  input.postalCode   ?? null,
      latitude:                     lat,
      longitude:                    lng,
      status:                       'pending',
    })
    .select('id')
    .single();

  if (error || !inserted) return { branchId: null, error: error?.message ?? 'Could not create branch.' };

  // Add the creating brand-admin as a practice_admin too so they can
  // manage the branch through the existing per-practice UI (members,
  // banking, etc.) once approved. Service-role INSERT — the existing
  // practice_members RLS allows it through.
  await client.from('practice_members').insert({
    practice_id:          inserted.id,
    user_id:              guard.userId,
    role:                 'admin',
    active:               true,
    can_create_bills:     true,
    can_manage_practice:  true,
    payout_destination:   'practice',
  });

  revalidatePath('/brand');
  revalidatePath('/admin/practices');
  return { branchId: inserted.id as string, error: null };
}

// ─── updateOwnGroup ────────────────────────────────────────────────────
//
// Edit the brand's display details — name, logo. Banking on the group
// row is intentionally NOT exposed to brand-admins here (group-level
// banking is platform-admin territory via app/admin/groups, kept that
// way so a brand-admin can't redirect payouts to their own account).

export type UpdateGroupInput = {
  groupId: string;
  name:    string;
  logoUrl: string | null;
};

export async function updateOwnGroup(input: UpdateGroupInput): Promise<{ error: string | null }> {
  const guard = await guardBrandAdmin(input.groupId);
  if (!guard.ok) return { error: guard.error };

  if (!input.name.trim()) return { error: 'Brand name is required.' };

  // Service-role UPDATE — the existing platform_admin_all_practice_groups
  // policy doesn't grant write to brand-admins, and we intentionally
  // don't add such a policy (group-level rights are a small, fixed
  // surface and easier to reason about as action-gated writes).
  // Allowlist ONLY name + logo_url; any future column on
  // practice_groups stays beyond brand-admin reach by default.
  const { error } = await svc()
    .from('practice_groups')
    .update({
      name:     input.name.trim(),
      logo_url: input.logoUrl?.trim() || null,
    })
    .eq('id', input.groupId);

  if (error) return { error: error.message };

  revalidatePath('/brand');
  revalidatePath('/brand/group');
  return { error: null };
}

// ─── updateBranchDetails ───────────────────────────────────────────────
//
// Edit a branch's descriptive fields: name, phone, full address +
// coordinates (re-picked via the Places (New) Autocomplete on the
// client; lat/lng come straight from the picked Place so address and
// coords cannot drift). SA-range backstop on the coords.
//
// LOCKED columns deliberately ABSENT from the UPDATE payload (and
// from the input shape):
//   • status, approved_at, approved_by, fee_percent
//   • owner_id, group_id, created_at
//   • banking columns (handled by updateBranchBanking, separately
//     audited)
//   • email (the practice email is the login for the original
//     practice-admin; changing it here would silently break login.
//     Use the admin platform to change it — same posture as 0054.)
//
// Service-role client + explicit column allowlist — the lock at this
// layer is "the action's UPDATE only sets the allowed columns". The
// 0054 trigger is bypassed by service-role, so the action body IS
// the security boundary; a source-text test asserts the payload
// never references the locked columns.

export type UpdateBranchDetailsInput = {
  practiceId:    string;
  name:          string;
  phone:         string | null;
  addressLine1:  string;
  addressLine2:  string | null;
  suburb:        string | null;
  city:          string | null;
  province:      string | null;
  postalCode:    string | null;
  latitude:      number | null;
  longitude:     number | null;
};

export async function updateBranchDetails(input: UpdateBranchDetailsInput): Promise<{ error: string | null }> {
  const guard = await guardBrandAdminOfPractice(input.practiceId);
  if (!guard.ok) return { error: guard.error };

  if (!input.name.trim())         return { error: 'Practice name is required.' };
  if (!input.addressLine1.trim()) return { error: 'Address is required.' };

  // SA-range backstop on the picker coords. Real ZA-restricted Places
  // results can't trip this; a tampered payload could.
  const lat: number | null = input.latitude;
  const lng: number | null = input.longitude;
  if (lat != null && lng != null && !isWithinSouthAfrica(lat, lng)) {
    return { error: 'Coordinates are outside South Africa — re-pick the address from the suggestions.' };
  }

  const { error } = await svc()
    .from('practices')
    .update({
      name:               input.name.trim(),
      phone:              input.phone?.trim() || null,
      address_line1:      input.addressLine1.trim(),
      address_line2:      input.addressLine2?.trim() || null,
      suburb:             input.suburb?.trim()       || null,
      city:               input.city?.trim()         || null,
      practice_province:  input.province?.trim()     || null,
      postal_code:        input.postalCode?.trim()   || null,
      latitude:           lat,
      longitude:          lng,
    })
    .eq('id', input.practiceId);

  if (error) return { error: error.message };

  revalidatePath('/brand');
  revalidatePath(`/brand/branch/${input.practiceId}`);
  return { error: null };
}

// ─── updateBranchBanking ───────────────────────────────────────────────
//
// Brand-admin edits a branch's banking. Separate action (not folded
// into updateBranchDetails) so the operation is independently
// audit-traceable and harder to slip into via a payload-mixing
// regression. Same allowlist discipline + same authz guard.
//
// Validation: account_type is constrained to ('current' | 'savings')
// by the existing CHECK constraint on `practices.account_type`. The
// server normalises an empty/missing value to NULL so the row can
// drop banking entirely (e.g. moving from per-branch billing to
// brand-level fallback).

export type UpdateBranchBankingInput = {
  practiceId:        string;
  bankName:          string | null;
  bankAccountNumber: string | null;
  branchCode:        string | null;
  accountHolder:     string | null;
  accountType:       'current' | 'savings' | null;
};

export async function updateBranchBanking(input: UpdateBranchBankingInput): Promise<{ error: string | null }> {
  const guard = await guardBrandAdminOfPractice(input.practiceId);
  if (!guard.ok) return { error: guard.error };

  if (input.accountType !== null && input.accountType !== 'current' && input.accountType !== 'savings') {
    return { error: "Account type must be 'current' or 'savings'." };
  }

  const { error } = await svc()
    .from('practices')
    .update({
      bank_name:           input.bankName?.trim()           || null,
      bank_account_number: input.bankAccountNumber?.trim()  || null,
      branch_code:         input.branchCode?.trim()         || null,
      account_holder:      input.accountHolder?.trim()      || null,
      account_type:        input.accountType                || null,
    })
    .eq('id', input.practiceId);

  if (error) return { error: error.message };

  revalidatePath('/brand');
  revalidatePath(`/brand/branch/${input.practiceId}`);
  return { error: null };
}
