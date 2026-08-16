'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { isValidEmail } from '@/lib/validation/email';

// ─── Admin actions: grant / revoke the 'sales' role ──────────────────────
//
// Only platform admins can call these. The service-role client is used
// for the profiles.role write so the 0054 column-lock trigger sees
// `auth.role() = 'service_role'` and lets the write through. All
// authorization decisions happen server-side via guardAdmin() before
// any write fires — the service-role client bypasses RLS entirely.

type GuardOk  = { ok: true;  userId: string };
type GuardErr = { ok: false; error:  string };

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

// ─── grantSalesRole ─────────────────────────────────────────────────────
//
// Look up a profile by email (case-insensitive), verify it currently
// has a non-'admin' role (we never demote the founder/only admin), then
// flip role='sales'. Returns { error, granted } for the UI to display.

export async function grantSalesRole(email: string): Promise<{
  error: string | null;
  granted?: { id: string; email: string; previousRole: string | null } | null;
}> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    return { error: 'Enter a valid email address.' };
  }

  const s = svc();

  const { data: profile } = await s
    .from('profiles')
    .select('id, email, role')
    .ilike('email', cleanEmail)
    .maybeSingle();

  if (!profile) {
    return { error: 'No user found with that email. Ask them to sign up first, then try again.' };
  }
  if (profile.role === 'admin') {
    return { error: 'This user is an admin. Admin already has CRM access — no separate sales role needed.' };
  }
  if (profile.role === 'sales') {
    return { error: 'This user already has the sales role.' };
  }

  // patient → sales REMOVES this row from 0097's partial unique index
  // (which covers role='patient' only), so this direction can never
  // collide. The mirror case is handled in revokeSalesRole.
  const { error: updErr } = await s
    .from('profiles')
    .update({ role: 'sales' })
    .eq('id', profile.id);

  if (updErr) return { error: updErr.message };

  revalidatePath('/admin/sales-team');
  return {
    error: null,
    granted: { id: profile.id, email: profile.email, previousRole: profile.role },
  };
}

// ─── revokeSalesRole ────────────────────────────────────────────────────
//
// Flip a user's role from 'sales' back to 'patient'. We do not attempt
// to restore whatever role they had before — the previous role isn't
// stored anywhere and re-granting patient is the safe default (they can
// still use the platform as a patient).

export async function revokeSalesRole(userId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const s = svc();

  const { data: profile } = await s
    .from('profiles')
    .select('id, role')
    .eq('id', userId)
    .maybeSingle();

  if (!profile) return { error: 'User not found.' };
  if (profile.role !== 'sales') return { error: 'User does not have the sales role.' };

  const { error } = await s
    .from('profiles')
    .update({ role: 'patient' })
    .eq('id', userId);

  // The unique index added in 0097 is PARTIAL on role='patient', so a row
  // only enters it when its role becomes 'patient' — which is exactly what
  // this update does. If some other patient account already holds this
  // person's SA ID, the demotion violates the index at UPDATE time. The
  // reverse direction (grantSalesRole) can never collide: it removes a row
  // from the index.
  //
  // Raw Postgres text ("duplicate key value violates unique constraint …")
  // tells an admin nothing about what to do, so it is translated. Nothing
  // is auto-resolved here — deciding which of two accounts keeps an ID is
  // not a side effect a role change should have.
  if (error) {
    const raw = error.message ?? String(error);
    if (error.code === '23505' || /profiles_sa_id_lookup_hash_patient_uniq/.test(raw)) {
      return {
        error:
          'This user cannot be returned to the patient role: their ID number is already ' +
          'registered to a different patient account. Resolve the duplicate ID first, then retry.',
      };
    }
    return { error: raw };
  }

  revalidatePath('/admin/sales-team');
  return { error: null };
}
