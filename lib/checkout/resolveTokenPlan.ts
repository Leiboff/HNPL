// ─── "Which plan does this checkout token belong to?" ───────────────────
//
// Deliberately DIFFERENT from resolveCheckoutToken in
// app/checkout/[token]/actions.ts, and the difference is the whole point
// of the file existing separately.
//
// That one answers "is this token still USABLE" — it filters on
// accepted_at IS NULL, on an unexpired expires_at, and on the session
// stage being open, because it guards an action that is about to create an
// account and lay down a payment schedule.
//
// This one answers "what plan was this token ISSUED FOR", with no
// liveness filter at all. The completion page needs that question and not
// the other one: by the time the browser returns from the widget the
// payment has usually already succeeded, and the webhook may well have
// closed the token (activateFirstInstalment stamps accepted_at and
// advances the session stage). A liveness-filtered lookup would refuse the
// legitimate return trip precisely when everything went right.
//
// Used by app/checkout/[token]/complete to bind its `checkoutId` query
// parameter to the token in its own path — see the F-07 comment there.

export type ResolvedTokenPlan = {
  kind:   'invitation' | 'session';
  planId: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

export async function resolveTokenPlan(
  svc:   Svc,
  token: string,
): Promise<ResolvedTokenPlan | null> {
  if (!token) return null;

  const { data: invitation } = await svc
    .from('patient_invitations')
    .select('plan_id')
    .eq('token', token)
    .maybeSingle();
  if (invitation?.plan_id) {
    return { kind: 'invitation', planId: invitation.plan_id as string };
  }

  const { data: session } = await svc
    .from('checkout_sessions')
    .select('plan_id')
    .eq('token', token)
    .maybeSingle();
  if (session?.plan_id) {
    return { kind: 'session', planId: session.plan_id as string };
  }

  return null;
}
