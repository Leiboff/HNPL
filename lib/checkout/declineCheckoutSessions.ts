import { createClient as createServiceClient } from '@supabase/supabase-js';

// ─── Plan ended → close its checkout session ─────────────────────────────
//
// The one place that knows which session stages are still open, and therefore
// the only place allowed to close one on behalf of a plan that has ended. Two
// endings route through it today:
//
//   declineCheckoutSessionsForPlan  the patient refused the bill (declinePlan,
//                                   app/patient/actions.ts) -> 'declined'
//   failCheckoutSessionsForPlan     the first instalment charge was rejected
//                                   (the Peach webhook's payment.failure
//                                   branch) -> 'payment_failed'
//
// They differ ONLY in the stage they write. Everything that makes them safe —
// what counts as terminal, matching by plan id, the no-op for a bill that has
// no session — is shared, because two copies of that predicate is how one of
// them starts overwriting history the other one wrote.
//
// The filename is historical: decline was the first of these to be wired.
//
// WHAT THIS CLOSES
//   checkout_sessions.stage has permitted 'declined' since migration 0085
//   and nothing ever wrote it. Abandonment (both the 2-minute timeout and
//   the teller's "Start next patient") lands on 'expired' via
//   expire_stale_checkout_session; completion lands on 'completed' from
//   app/checkout/[token]/complete/page.tsx. A patient's own explicit
//   decline — declinePlan in app/patient/actions.ts — moved the PLAN to
//   'declined' and left the session where it was, so the till's activity
//   strip reported "Waiting on patient" for a bill that had been refused.
//
// WHY THIS DOES NOT SELF-HEAL WITHOUT IT
//   The obvious assumption is that expiry mops this up a couple of minutes
//   later. It does not. expire_stale_checkout_session only advances a stage
//   when the PLAN is still in ('pending_acceptance', 'pending_first_payment')
//   — the moment declinePlan sets status='declined', the lazy fail-safe
//   becomes a permanent no-op and the session is frozen mid-flight forever.
//   That is what makes this a propagation gap rather than a timing one.
//
// WHY SERVICE ROLE
//   checkout_sessions (0085) grants no INSERT or UPDATE policy to anon or
//   authenticated — every write goes through a service-role client by
//   design. The patient's own RLS client would silently match zero rows
//   here, which is the worst of both worlds: no error, no write. The
//   escalation is deliberately confined to this one narrow function rather
//   than handing app/patient/actions.ts a service-role client it has never
//   needed for anything else.
//
// WHY MATCHED BY plan_id
//   Same reasoning as the completion page's own stage write, which this
//   deliberately mirrors rather than inventing a third shape: the patient
//   declining holds a plan id, never a session token, and the session's
//   token is not derivable from it. plan_id is the join both directions
//   already use.

/**
 * Loose structural type, same reason as lib/practice/tillActivity.ts: naming
 * Supabase's generic builder makes TypeScript report "type instantiation is
 * excessively deep" at the call sites.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CloseSessionsSupabase = any;

/**
 * The stages a session can still LEAVE.
 *
 * Deliberately the positive form of expire_stale_checkout_session's own
 * `IF v_session.stage NOT IN ('created', 'scanned') THEN RETURN` guard, so
 * every path that closes a session agrees on what "still open" means. Anything
 * outside this set is terminal and truthful already:
 *
 *   completed       the money moved. Never rewritten from here — an ending
 *                   arriving after a completion is an ending on a plan that
 *                   was already paid, which is a different problem and not one
 *                   to paper over by editing the session's history.
 *   expired         the session ran out of time or the teller moved on.
 *                   Already terminal and already accurate about what happened
 *                   AT THE TILL, which is the only thing this row describes.
 *   declined        the patient refused the bill.
 *   payment_failed  the first instalment charge was rejected (migration 0095).
 *
 * The last two are also what makes a repeat call a no-op: a session already in
 * its ending cannot be moved to another one.
 */
export const OPEN_CHECKOUT_STAGES = ['created', 'scanned'] as const;

/**
 * The endings a plan can impose on its session.
 *
 * Two, and deliberately distinct: at a counter, "the patient refused this
 * bill" and "the card didn't go through" call for opposite responses from the
 * front desk, so collapsing them into one value would make the till's activity
 * strip advise the wrong action. The stage names are what the strip reads to
 * choose its wording.
 */
export const CLOSING_STAGES = ['declined', 'payment_failed'] as const;
export type ClosingStage = (typeof CLOSING_STAGES)[number];

function svc(): CloseSessionsSupabase {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export type CloseSessionsResult = {
  /** How many session rows actually moved. 0 is the normal case, not a failure. */
  closed: number;
  error:  string | null;
};

/**
 * Move any still-open counter session for this plan into a terminal stage.
 *
 * Idempotent and safe to call for every plan, including plans that have no
 * session at all: an email-issued bill (createBill + patient_invitations)
 * has zero checkout_sessions rows, so the UPDATE matches nothing and
 * returns `{ closed: 0, error: null }`. That is a clean no-op by
 * construction rather than a case the caller has to detect first.
 *
 * Written for a SET of rows even though issueCounterSession mints a fresh
 * plan per session — so one plan has at most one — because the schema
 * permits several (plan_id carries no unique constraint) and a predicate
 * that only works for exactly one row is a predicate that breaks silently
 * the day that changes.
 *
 * Never throws: both callers run in contexts where an exception is worse than
 * a stale stage (a patient-facing action that has already succeeded, and a
 * webhook that must answer 200 or trigger Peach's retry ladder).
 *
 * @param planId   the plan the caller has ALREADY authorised and ended
 * @param stage    which ending to record
 * @param supabase injectable so a caller that already holds a service-role
 *                 client can pass it, and so tests can drive the real
 *                 predicate against a real database
 */
async function closeOpenSessionsForPlan(
  planId:   string,
  stage:    ClosingStage,
  supabase: CloseSessionsSupabase = svc(),
): Promise<CloseSessionsResult> {
  const { data, error } = await supabase
    .from('checkout_sessions')
    .update({ stage })
    .eq('plan_id', planId)
    .in('stage', [...OPEN_CHECKOUT_STAGES])
    .select('id');

  if (error) return { closed: 0, error: error.message ?? String(error) };
  return { closed: (data ?? []).length, error: null };
}

/**
 * The patient refused the bill — declinePlan in app/patient/actions.ts.
 */
export function declineCheckoutSessionsForPlan(
  planId:   string,
  supabase?: CloseSessionsSupabase,
): Promise<CloseSessionsResult> {
  return closeOpenSessionsForPlan(planId, 'declined', supabase ?? svc());
}

/**
 * The first instalment charge was rejected — the Peach webhook's
 * payment.failure branch, which sets plans.status='cancelled' and until now
 * left the session frozen mid-flight.
 *
 * Note this stage is terminal for THIS module but not for the checkout
 * completion route, whose `.neq('stage', 'completed')` write can still carry a
 * session from 'payment_failed' to 'completed'. That is deliberate: the failure
 * card offers a retry with a different card, and a retry that succeeds must be
 * able to finish the story.
 */
export function failCheckoutSessionsForPlan(
  planId:   string,
  supabase?: CloseSessionsSupabase,
): Promise<CloseSessionsResult> {
  return closeOpenSessionsForPlan(planId, 'payment_failed', supabase ?? svc());
}
