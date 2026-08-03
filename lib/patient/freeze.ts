// ─── Default freeze — patient-level "has an unresolved default" gate ────────
//
// Decided policy: a SINGLE default anywhere freezes the patient out of
// taking ANY new plan (hard block, not a graduated allowance cut). The
// freeze lifts the moment the defaulted debt is settled.
//
// Ladder state is per-INSTALMENT (payments.status = 'defaulted'). This is
// the single source of truth that rolls that up to the PATIENT: TRUE iff
// the patient has any payment row still in 'defaulted'. No new column —
// it's derivable, so there's no migration (a settled default leaves
// 'defaulted' → collected/processing and the predicate flips to false for
// free).
//
// The join is on plans.patient_id (not payments.patient_id) so it's
// correct even for legacy payment rows whose own patient_id is null and
// only the plan carries the owner. Works with either a session client
// (RLS scopes to the caller's own rows anyway) or a service-role client.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any;

/**
 * TRUE iff the patient has at least one UNRESOLVED defaulted payment.
 *
 * "Unresolved" == status is still 'defaulted'. Settling a defaulted row
 * (self-settle / settle-entire-bill) moves it to processing → collected,
 * so it stops counting the instant the debt is paid.
 *
 * Fails OPEN (returns false) on a query error — a transient DB blip must
 * not block a legitimate patient from transacting; the error is logged
 * for observability. The gate is a risk control, not a legal hard-stop.
 */
export async function isPatientFrozen(client: Client, patientId: string): Promise<boolean> {
  if (!patientId) return false;
  const { data, error } = await client
    .from('payments')
    .select('id, plans!inner(patient_id)')
    .eq('plans.patient_id', patientId)
    .eq('status', 'defaulted')
    .limit(1);

  if (error) {
    console.warn('[freeze] isPatientFrozen query failed — failing open (not frozen)', {
      patientId,
      message: error.message,
    });
    return false;
  }
  return (data?.length ?? 0) > 0;
}
