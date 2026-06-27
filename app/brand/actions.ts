'use server';

import { revalidatePath } from 'next/cache';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { isWithinSouthAfrica } from '@/lib/maps/saBounds';

// ─── Brand-admin server actions (Phase 1 minimal) ──────────────────────
//
// One action surface owned by brand-admins: createBranch (which
// creates a pending practice under a group they admin). The action
// uses the service-role client for the INSERT because:
//   • RLS on practices has no permissive INSERT policy for non-owners
//     (a brand-admin is not the practice's owner_id at this point —
//     they're creating the branch ON BEHALF of the group).
//   • The 0054 column-lock trigger fires only on UPDATE, not INSERT,
//     so a service-role INSERT with status='pending' is the correct
//     posture — the trigger then blocks any subsequent status change
//     from a non-service-role caller.
//
// Approval continues to flow through the existing platform-admin
// path (app/admin/practices/actions.ts approvePractice). Brand-admin
// never approves their own branch.
//
// Standalone practices (group_id NULL) are untouched by this file —
// these actions only apply when the caller is a brand-admin of a
// specific group.

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
