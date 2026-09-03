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
// enforces is whatever the assessment pipeline granted.
//
// It used to enforce a stubbed unconditional R5,000 and said so here. That
// stub is gone; the limit now comes from lib/underwriting/limit.ts via the
// assessment pipeline, and — exactly as this comment predicted — the number
// the real policy returns started binding with no further wiring, because
// the enforcement never cared where the figure came from.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

type PlanExposureRow = {
  id: string;
  status: string;
  full_value_exposure: boolean | null;
  financed_amount: number | string | null;
  total_amount: number | string | null;
  excess_amount: number | string | null;
};

/** Statuses a legacy (declining-balance) plan counts in. Unchanged from 0130. */
const LEGACY_STATUSES = ['pending_first_payment', 'active'];

/**
 * Everything we need to fetch. `defaulted` is here for the full-value model
 * only — the filter below drops it for legacy plans, so no plan accepted
 * under the old rules starts consuming more than it did.
 */
const EXPOSURE_STATUSES = [...LEGACY_STATUSES, 'defaulted'];

/**
 * A patient's committed credit exposure, in rands.
 *
 * ─── TWO MODELS, DISCRIMINATED PER PLAN ───────────────────────────────
 *
 * Plans originated from migration 0140 onward carry
 * `full_value_exposure = TRUE` and hold their ENTIRE financed value for
 * their whole life. Two instalments into a three-instalment plan is the
 * same exposure as day one; the whole amount is released in one step at
 * completion, and partial payments free nothing.
 *
 * Plans written before that keep the declining-balance arithmetic they
 * were accepted under — uncollected instalments less this plan's own
 * excess while instalment 1 is outstanding — so no in-flight plan's
 * headroom moved when the model changed. The two coexist until the last
 * legacy plan closes.
 *
 * Under the new model a DEFAULTED plan still counts: the debt is still
 * owed. A cancelled or completed one does not.
 *
 * This is the optimistic, UNLOCKED read used to compute a split before
 * calling the claim RPC. The RPC re-derives the same quantity under a row
 * lock via `patient_credit_exposure()` and is the authority; the two
 * implementations are pinned against each other by
 * 0130_claim_credit_for_plan.rpc.test.ts. Two copies is a known cost —
 * one copy that is not under a lock was the A-04 bug.
 *
 * `excludePlanId` is the plan being accepted right now. On the resume
 * paths (payWithSavedCard re-entering an abandoned pending_first_payment
 * plan, initiateCheckout re-entering its own) that plan's rows are ALREADY
 * in the table, so counting them and then adding the bill total again
 * would charge the customer twice for one bill and refuse a legitimate
 * resume.
 */
export async function outstandingExposure(
  svc:  Svc,
  patientId: string,
  opts?: { excludePlanId?: string | null },
): Promise<{ ok: true; rands: number } | { ok: false }> {
  const { data: livePlans, error: planErr } = await svc
    .from('plans')
    .select('id, status, full_value_exposure, financed_amount, total_amount, excess_amount')
    .eq('patient_id', patientId)
    .in('status', EXPOSURE_STATUSES);

  // A failed lookup is not permission to proceed — same posture as the SA-ID
  // duplicate check in checkout. We cannot tell "no exposure" apart from
  // "could not read", and one of those answers gives away money.
  if (planErr) return { ok: false };

  const plans = ((livePlans ?? []) as PlanExposureRow[])
    .filter((p) => p.id !== opts?.excludePlanId)
    // A defaulted plan counts only under the full-value model. Under the
    // legacy one it never did, and this read must not retroactively change
    // what an in-flight plan consumes.
    .filter((p) => p.full_value_exposure === true || LEGACY_STATUSES.includes(p.status));

  if (plans.length === 0) return { ok: true, rands: 0 };

  let cents = 0;

  // Full-value plans need no payment rows at all — that is the point.
  const fullValue = plans.filter((p) => p.full_value_exposure === true);
  for (const p of fullValue) {
    const value = p.financed_amount ?? p.total_amount ?? 0;
    cents += Math.round(Number(value) * 100);
  }

  const legacy = plans.filter((p) => p.full_value_exposure !== true);
  if (legacy.length > 0) {
    const { data: rows, error: payErr } = await svc
      .from('payments')
      .select('plan_id, amount, instalment_number')
      .in('plan_id', legacy.map((p) => p.id))
      .eq('kind', 'instalment')
      .neq('status', 'collected');

    if (payErr) return { ok: false };

    const uncollected = (rows ?? []) as Array<{
      plan_id: string; amount: number | string; instalment_number: number | null;
    }>;

    for (const plan of legacy) {
      const mine = uncollected.filter((r) => r.plan_id === plan.id);
      if (mine.length === 0) continue;

      let planCents = mine.reduce(
        (sum, r) => sum + Math.round(Number(r.amount) * 100), 0);

      // The excess is the customer's own money in flight, not credit, and
      // comes off while instalment 1 is still uncollected.
      if (mine.some((r) => Number(r.instalment_number) === 1)) {
        planCents -= Math.round(Number(plan.excess_amount ?? 0) * 100);
      }
      cents += planCents;
    }
  }

  return { ok: true, rands: cents / 100 };
}
