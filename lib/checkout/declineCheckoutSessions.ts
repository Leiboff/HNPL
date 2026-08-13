import { createClient as createServiceClient } from '@supabase/supabase-js';

// ─── Plan decline → checkout session decline ─────────────────────────────
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
export type DeclineSessionsSupabase = any;

/**
 * The stages a session can still LEAVE.
 *
 * Deliberately the positive form of expire_stale_checkout_session's own
 * `IF v_session.stage NOT IN ('created', 'scanned') THEN RETURN` guard, so
 * both propagation paths agree on what "still open" means. Anything outside
 * this set is terminal and truthful already:
 *
 *   completed  the money moved. Never rewritten — a decline arriving after
 *              a completion is a decline of a plan that was already paid,
 *              which is a different problem and not one to paper over by
 *              editing the session's history.
 *   expired    the session ran out of time or the teller moved on. Already
 *              terminal and already accurate about what happened AT THE
 *              TILL, which is the only thing this row describes.
 *   declined   already done — which is what makes a second call a no-op.
 */
export const OPEN_CHECKOUT_STAGES = ['created', 'scanned'] as const;

function svc(): DeclineSessionsSupabase {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export type DeclineSessionsResult = {
  /** How many session rows actually moved. 0 is the normal case, not a failure. */
  declined: number;
  error:    string | null;
};

/**
 * Move any still-open counter session for this plan to stage='declined'.
 *
 * Idempotent and safe to call for every plan, including plans that have no
 * session at all: an email-issued bill (createBill + patient_invitations)
 * has zero checkout_sessions rows, so the UPDATE matches nothing and
 * returns `{ declined: 0, error: null }`. That is a clean no-op by
 * construction rather than a case the caller has to detect first.
 *
 * Written for a SET of rows even though issueCounterSession mints a fresh
 * plan per session — so one plan has at most one — because the schema
 * permits several (plan_id carries no unique constraint) and a predicate
 * that only works for exactly one row is a predicate that breaks silently
 * the day that changes.
 *
 * @param planId   the plan the caller has ALREADY authorised and declined
 * @param supabase injectable only so tests can drive the real predicate
 *                 against a real database; production always uses the
 *                 narrow service-role client built above
 */
export async function declineCheckoutSessionsForPlan(
  planId:   string,
  supabase: DeclineSessionsSupabase = svc(),
): Promise<DeclineSessionsResult> {
  const { data, error } = await supabase
    .from('checkout_sessions')
    .update({ stage: 'declined' })
    .eq('plan_id', planId)
    .in('stage', [...OPEN_CHECKOUT_STAGES])
    .select('id');

  if (error) return { declined: 0, error: error.message ?? String(error) };
  return { declined: (data ?? []).length, error: null };
}
