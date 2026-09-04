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
// ─── WHAT REMAINS HERE, AND WHAT MOVED, 2026-09-02 (audit A-04) ─────────
//
// This module used to export `checkCreditLimit` as well: a read of the limit,
// a read of the exposure, and a decision returned to the caller — which then
// wrote the schedule. Three callers did exactly that, and every one of them
// had a window between the decision and the write in which a concurrent
// request read the same headroom and spent it too. Five parallel acceptances
// against a R5,000 limit all passed; the proof is in
// creditLimit.race.adversarial.test.ts.
//
// A check-then-write helper cannot be made safe by its callers, so it is
// gone rather than deprecated. The decision and the write are now ONE
// statement inside `claim_credit_for_plan` (migration 0130), under a row lock
// on the patient's profile, reached through lib/underwriting/claimCredit.ts.
//
// What stays here is `outstandingExposure` — the exposure arithmetic and the
// definition of what counts as outstanding, which the claim path still uses
// for its optimistic pre-read, and which the RPC re-derives for itself under
// the lock. Two implementations of that definition is a known cost, pinned
// against each other by 0130_claim_credit_for_plan.rpc.test.ts; one
// implementation that is not under a lock was the bug.
//
// The refusal copy stays too, and is the single source for both — claimCredit
// re-exports it through CLAIM_MESSAGES.
//
// WHAT THIS MODULE IS AND IS NOT
//
// It is the exposure arithmetic and the refusal, in one place, so the
// acceptance paths cannot drift. It is NOT underwriting: the limit it
// enforces is whatever lib/underwriting/affordabilityPolicy returned, and
// that module currently returns no limit at all — the R5,000 stub that used
// to grant one unconditionally has been removed. So this arithmetic binds
// immediately once the real credit check is configured, with no further
// wiring, and until then it refuses every acceptance for want of a number.
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

// Reached by an applicant who IS fully onboarded — acceptPlan runs the
// onboarding gate before the credit claim — so the old copy ("please finish
// setting up your account") sent them to a screen with nothing left to do.
// Since the R5,000 stub was removed, this is the normal state for everyone
// until the real credit check is live, so it has to say something true and
// actionable.
export const CREDIT_LIMIT_UNSET_REFUSAL =
  'We\'re still assessing how much you can spend, so we can\'t set up a plan '
  + 'just yet. We\'ll let you know as soon as your limit is ready.';

export const CREDIT_LIMIT_UNAVAILABLE_REFUSAL =
  'We couldn\'t check your available balance just now. Please try again in a moment.';

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
