'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { isWithinSouthAfrica, SA_BOUNDS } from '@/lib/maps/saBounds';

// ─── Server-side admin guard ─────────────────────────────────────────────────
//
// Mirrors the verifyAdmin() helper in app/admin/page.tsx — uses the SSR
// client's getUser() to identify the caller, then reads profiles.role to
// confirm admin status. We do NOT trust client-side UI gating; both
// approvePractice and suspendPractice run this check before any write.
//
// AUTHZ POSTURE NOTE (2026-06-22, fix 0054):
//   The writes below switched to the service-role client so that the
//   BEFORE UPDATE trigger added by migration 0054
//   (protect_practices_columns) sees `auth.role() = 'service_role'`
//   and lets the protected-column write through. The service-role
//   client bypasses RLS, so the guardAdmin() check below is now the
//   sole authz gate on these writes. It MUST run first and pass
//   before any service-role write fires. Reordering this is unsafe.

type GuardOk = {
  ok:        true;
  userId:    string;
};
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

  if (profile?.role !== 'admin') {
    return { ok: false, error: 'Unauthorized.' };
  }

  return { ok: true, userId: user.id };
}

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

// ─── approvePractice ─────────────────────────────────────────────────────────
//
// Flips practices.status to 'approved' and stamps the audit columns added
// by migration 0046 (approved_at, approved_by). The trading gate
// (lib/practice/tradingGate.ts) and the RLS function from 0043 both
// observe this transition immediately — the practice can trade as soon
// as it ALSO has >= 1 active provider.

export async function approvePractice(practiceId: string): Promise<{ error: string | null }> {
  // App-level admin gate — sole authz on the service-role write that
  // follows. MUST run + pass before the write fires.
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const { error } = await svc()
    .from('practices')
    .update({
      status:       'approved',
      approved_at:  new Date().toISOString(),
      approved_by:  guard.userId,
    })
    .eq('id', practiceId);

  if (error) return { error: error.message };

  revalidatePath('/admin/practices');
  return { error: null };
}

// ─── suspendPractice ─────────────────────────────────────────────────────────
//
// Flips status to 'suspended'. Does NOT clear approved_at / approved_by —
// the audit trail preserves the first approval. If we later need a full
// status-event history we'll add a separate table.

export async function suspendPractice(practiceId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const { error } = await svc()
    .from('practices')
    .update({ status: 'suspended' })
    .eq('id', practiceId);

  if (error) return { error: error.message };

  revalidatePath('/admin/practices');
  return { error: null };
}

// ─── updatePracticeAddressFromPlace — admin re-pick via Places (New) ───
//
// Replaces the old "re-geocode from stored address" flow. The admin
// uses the Places (New) Autocomplete in the coords panel to pick the
// correct place; this action writes its coords + formatted address
// (and parsed sub-fields) back to the practice row.
//
// Cost-correctness: the picker on the client owns the Places session
// token; this action accepts the resolved place data and just writes.
// No server-side Places call → no second key, no double billing.

export type PlacePickPayload = {
  latitude:        number;
  longitude:       number;
  formattedAddress: string;
  suburb?:         string | null;
  city?:           string | null;
  province?:       string | null;
  postalCode?:     string | null;
};

export async function updatePracticeAddressFromPlace(
  practiceId: string,
  place:      PlacePickPayload,
): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  // SA-range backstop. Real Google ZA-restricted Places shouldn't trip
  // this, but a tampered client payload could.
  if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) {
    return { error: 'Latitude and longitude must be numbers.' };
  }
  if (!isWithinSouthAfrica(place.latitude, place.longitude)) {
    return {
      error:
        `Coordinates outside South Africa. Expected lat ∈ [${SA_BOUNDS.latMin}, ${SA_BOUNDS.latMax}], ` +
        `lng ∈ [${SA_BOUNDS.lngMin}, ${SA_BOUNDS.lngMax}].`,
    };
  }
  if (!place.formattedAddress.trim()) {
    return { error: 'Formatted address is empty.' };
  }

  const { error } = await svc()
    .from('practices')
    .update({
      latitude:           place.latitude,
      longitude:          place.longitude,
      address_line1:      place.formattedAddress,
      suburb:             place.suburb     ?? null,
      city:               place.city       ?? null,
      practice_province:  place.province   ?? null,
      postal_code:        place.postalCode ?? null,
    })
    .eq('id', practiceId);
  if (error) return { error: error.message };

  revalidatePath(`/admin/practices/${practiceId}`);
  return { error: null };
}

// ─── setPracticeCoordinates — admin manual override ────────────────────
//
// Lets an admin hand-correct coordinates when geocoding fails or
// returns the wrong pin (rare but happens — duplicated suburb names,
// new estates Google doesn't know yet). Validates the SA range so a
// transposed-sign typo (positive latitude → Arabian Sea) is rejected
// at the action layer before it lands in the DB.

export async function setPracticeCoordinates(
  practiceId: string,
  latitude:   number,
  longitude:  number,
): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { error: 'Latitude and longitude must be numbers.' };
  }

  if (!isWithinSouthAfrica(latitude, longitude)) {
    return {
      error:
        `Coordinates outside South Africa. Expected lat ∈ [${SA_BOUNDS.latMin}, ${SA_BOUNDS.latMax}], ` +
        `lng ∈ [${SA_BOUNDS.lngMin}, ${SA_BOUNDS.lngMax}]. Common cause: latitude sign flipped.`,
    };
  }

  const { error } = await svc()
    .from('practices')
    .update({ latitude, longitude })
    .eq('id', practiceId);
  if (error) return { error: error.message };

  revalidatePath(`/admin/practices/${practiceId}`);
  return { error: null };
}

// ─── clearPracticeCoordinates — admin can NULL coords ──────────────────
//
// Reverses a bad manual entry / takes the practice out of the
// "practices near me" filter without removing the address itself.

export async function clearPracticeCoordinates(practiceId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const { error } = await svc()
    .from('practices')
    .update({ latitude: null, longitude: null })
    .eq('id', practiceId);
  if (error) return { error: error.message };

  revalidatePath(`/admin/practices/${practiceId}`);
  return { error: null };
}
