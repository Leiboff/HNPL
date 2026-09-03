'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { recordAdminAction } from '@/app/admin/_lib/adminAudit';
import { decryptId } from '@/lib/idEncryption';
import { currentFlags } from '@/lib/featureFlags';
import { ensureAssessmentCurrent } from '@/lib/onboarding/creditAssessment';

// ─── Admin credit actions ──────────────────────────────────────────────
//
// The third re-assessment trigger. Staleness fires from the plan-request
// path and an increase request from the patient; this is the manual one,
// for support handling a case the automatic triggers do not cover — a
// patient who says their income has changed, or one parked in `pending`
// after a bureau outage.
//
// It runs the SAME path as the other two (`ensureAssessmentCurrent` with
// `adminTriggered`), so there is no second implementation of the pipeline
// that could drift from the real one. The only difference is the trigger
// recorded on the assessment row, which is what lets you tell
// admin-initiated repricings apart at calibration time.
//
// ─── WHAT AN ADMIN CANNOT DO HERE ──────────────────────────────────────
//
// Set a limit. There is deliberately no "override the limit to R X"
// action: a figure typed by a human has no assessment behind it, no
// coefficient version, and no row in the log explaining it — and it would
// be indistinguishable from a priced limit to every gate downstream.
// An admin can ask for the pipeline to run again. It still decides.
//
// The cooldown is likewise NOT bypassable from here. An admin trigger
// inside a live cooldown returns the cooldown message and spends nothing,
// because a support-desk button that re-runs billable enquiries on demand
// is exactly the hole the cooldown exists to close.

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function guardAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated.', userId: null };
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (p?.role !== 'admin') return { ok: false as const, error: 'Unauthorized.', userId: null };
  return { ok: true as const, error: null, userId: user.id };
}

export type ReassessResultForAdmin = {
  error: string | null;
  /** The limit now in force, when the run approved one. */
  limit?: number | null;
  /** False when a valid limit was already in place and nothing was spent. */
  reassessed?: boolean;
};

/**
 * Re-run the full assessment for one patient.
 *
 * Spends real money at Experian, so it is admin-only, audited, and
 * refuses inside a cooldown.
 */
export async function reassessPatientCredit(
  patientId: string,
): Promise<ReassessResultForAdmin> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  if (!currentFlags().creditCheck) {
    return { error: 'Credit assessment is not enabled in this environment.' };
  }

  const privileged = svc();

  const { data } = await privileged
    .from('profiles')
    .select('sa_id_number, salary_amount, role')
    .eq('id', patientId)
    .maybeSingle();

  const row = data as {
    sa_id_number: string | null;
    salary_amount: number | string | null;
    role: string | null;
  } | null;

  if (!row)                      return { error: 'Customer not found.' };
  if (row.role !== 'patient')    return { error: 'Not a patient account.' };
  if (!row.sa_id_number) {
    return { error: 'This customer has no verified ID number, so there is nothing to assess.' };
  }

  let idNumber: string;
  try {
    idNumber = decryptId(row.sa_id_number);
  } catch {
    console.error('[admin] ALERT could not decrypt a stored SA ID for re-assessment', { patientId });
    return { error: 'Could not read this customer\'s ID number. Please contact engineering.' };
  }

  const declared = row.salary_amount === null ? null : Number(row.salary_amount);

  const result = await ensureAssessmentCurrent(
    { svc: privileged, userId: patientId, idNumber, trigger: 'admin' },
    {
      adminTriggered: true,
      declaredIncomeRands: Number.isFinite(declared as number) ? (declared as number) : null,
    },
  );

  // Audited whichever way it went — a refusal is as much a privileged
  // action as an approval, and costs the same enquiry.
  await recordAdminAction({
    actorId:    guard.userId,
    entityType: 'customer',
    entityId:   patientId,
    action:     'credit_reassessed',
    // No income figure, no score, no band: the assessment row carries
    // those, and the audit log is read by more people than that table is.
    payload:    { outcome: result.ok ? 'approved' : 'refused' },
  });

  if (!result.ok) return { error: result.error };

  revalidatePath(`/admin/customers/${patientId}`);
  return { error: null, limit: result.limit, reassessed: result.reassessed };
}
