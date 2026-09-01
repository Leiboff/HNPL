// ─── The credit limit, actually enforced ────────────────────────────────
//
// THE DEFECT (audit 2026-09-01, F-10)
//
// `profiles.approved_credit_limit` was written by runCreditCheck, displayed
// on the patient dashboard, and read by NO gate anywhere. A grep across the
// whole tree returned six hits: one write, two display reads, three
// comments. acceptPlan, payWithSavedCard, initiateCheckout, createBill and
// issueCounterSession never consulted it.
//
// So the only things bounding how much credit a customer could draw were:
//
//   • isAllowedBillAmount — a GLOBAL R1-R50,000 band per bill, identical
//     for every customer and settable from an env var;
//   • isBlockedFromNewPlan — one open plan at a time, and only for
//     customers who have never completed a plan;
//   • isPatientFrozen — blocks a new plan while a default is unresolved.
//
// A repeat customer who had completed one plan was exempt from the second
// and so had no per-customer limit of any kind. The R5,000 the affordability
// step "granted" them was decoration.
//
// WHAT THIS MODULE IS AND IS NOT
//
// It is the exposure arithmetic and the refusal, in one place, so the four
// acceptance paths cannot drift. It is NOT underwriting: the limit it
// enforces is whatever `stubAffordabilityPolicy` granted, and that module's
// own header is emphatic that it performs no assessment of any kind.
// Enforcing a stub limit does not make the stub a policy. It does mean that
// when the stub is replaced, the number the real policy returns starts
// binding immediately with no further wiring.
//
// FAIL CLOSED ON A NULL LIMIT
//
// A patient with no `approved_credit_limit` has not been through the
// affordability step, so there is no number to check against and the answer
// is no. That is the opposite of the previous behaviour, where a NULL limit
// meant the dashboard widget simply did not render and the plan went ahead.
// The onboarding gate should already have caught this — but "two gates
// disagree about whether you may borrow" is exactly how F-05 turned into a
// financial hole, so this one does not defer.
//
// WHAT COUNTS AS OUTSTANDING
//
// Every instalment on a plan that is still live — `pending_first_payment`
// or `active` — that has not been collected. Deliberately NOT the plan
// totals: a customer three quarters of the way through a R10,000 plan has
// R2,500 of exposure, not R10,000, and charging them the full total would
// make the limit far tighter than the number they were shown.
//
// Settlement rows (kind='settlement', migration 0058) are excluded: they
// are a second row covering instalments that are ALSO still counted here,
// so including them would double-count the same debt.

export const CREDIT_LIMIT_REFUSAL =
  'This bill would take you over your approved limit. Pay down your current '
  + 'plan first, or contact us if you think your limit should be higher.';

export const CREDIT_LIMIT_UNSET_REFUSAL =
  'We don\'t have an approved limit on your account yet. Please finish setting '
  + 'up your account before taking on a bill.';

export const CREDIT_LIMIT_UNAVAILABLE_REFUSAL =
  'We couldn\'t check your available balance just now. Please try again in a moment.';

export type CreditLimitDecision =
  | { ok: true;  limit: number; outstanding: number; available: number }
  | { ok: false; reason: 'no_limit' | 'over_limit' | 'lookup_failed'; message: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

/**
 * Sum of uncollected instalments across the patient's live plans, in rands.
 *
 * `excludePlanId` is the plan being accepted right now. On the resume paths
 * (payWithSavedCard re-entering an abandoned pending_first_payment plan,
 * initiateCheckout re-entering its own) that plan's rows are ALREADY in the
 * table, so counting them and then adding the bill total again would charge
 * the customer twice for one bill and refuse a legitimate resume.
 */
export async function outstandingExposure(
  svc:  Svc,
  patientId: string,
  opts?: { excludePlanId?: string | null },
): Promise<{ ok: true; rands: number } | { ok: false }> {
  const { data: livePlans, error: planErr } = await svc
    .from('plans')
    .select('id')
    .eq('patient_id', patientId)
    .in('status', ['pending_first_payment', 'active']);

  // A failed lookup is not permission to proceed — same posture as the SA-ID
  // duplicate check in checkout. We cannot tell "no exposure" apart from
  // "could not read", and one of those answers gives away money.
  if (planErr) return { ok: false };

  const planIds = ((livePlans ?? []) as Array<{ id: string }>)
    .map((p) => p.id)
    .filter((id) => id !== opts?.excludePlanId);

  if (planIds.length === 0) return { ok: true, rands: 0 };

  const { data: rows, error: payErr } = await svc
    .from('payments')
    .select('amount')
    .in('plan_id', planIds)
    .eq('kind', 'instalment')
    .neq('status', 'collected');

  if (payErr) return { ok: false };

  const cents = ((rows ?? []) as Array<{ amount: number | string }>)
    .reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0);

  return { ok: true, rands: cents / 100 };
}

/**
 * Would taking on `billAmount` put this patient over their approved limit?
 *
 * Compared in integer cents, like everything else that touches money here —
 * a float comparison at the boundary would refuse a bill that lands exactly
 * on the limit about half the time.
 */
export async function checkCreditLimit(
  svc:        Svc,
  patientId:  string,
  billAmount: number,
  opts?: { excludePlanId?: string | null },
): Promise<CreditLimitDecision> {
  const { data: profile, error } = await svc
    .from('profiles')
    .select('approved_credit_limit')
    .eq('id', patientId)
    .maybeSingle();

  if (error) {
    console.error('[credit-limit] profile lookup failed', { patientId, error: error.message });
    return { ok: false, reason: 'lookup_failed', message: CREDIT_LIMIT_UNAVAILABLE_REFUSAL };
  }

  const rawLimit = profile?.approved_credit_limit as number | string | null | undefined;
  if (rawLimit === null || rawLimit === undefined) {
    return { ok: false, reason: 'no_limit', message: CREDIT_LIMIT_UNSET_REFUSAL };
  }

  const limitCents = Math.round(Number(rawLimit) * 100);
  if (!Number.isFinite(limitCents)) {
    return { ok: false, reason: 'no_limit', message: CREDIT_LIMIT_UNSET_REFUSAL };
  }

  const exposure = await outstandingExposure(svc, patientId, opts);
  if (!exposure.ok) {
    console.error('[credit-limit] exposure lookup failed', { patientId });
    return { ok: false, reason: 'lookup_failed', message: CREDIT_LIMIT_UNAVAILABLE_REFUSAL };
  }

  const outstandingCents = Math.round(exposure.rands * 100);
  const billCents        = Math.round(Number(billAmount) * 100);

  if (outstandingCents + billCents > limitCents) {
    return { ok: false, reason: 'over_limit', message: CREDIT_LIMIT_REFUSAL };
  }

  return {
    ok:          true,
    limit:       limitCents / 100,
    outstanding: outstandingCents / 100,
    available:   (limitCents - outstandingCents) / 100,
  };
}
