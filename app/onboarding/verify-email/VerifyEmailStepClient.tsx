'use client';

import VerifyEmailForm from '@/app/verify-email/VerifyEmailForm';

// ─── Verify email step (client) — thin wrapper ─────────────────────────
//
// After the onboarding-unification pass, this step re-uses the canonical
// VerifyEmailForm from the pre-existing /verify-email surface. Same
// verifyOtp call, same OtpInput (6-cell), same resend cooldown, same
// error classification — all identical between the standalone route
// and this onboarding step.
//
// `next` is the only onboarding-specific choice, and it is now the
// NEXT STEP'S path rather than "/onboarding".
//
// It used to be the router, which meant the hard navigation this form
// performs on success went: GET /onboarding (getUser round trip + profile
// read + computeOnboarding) → 307 → GET /onboarding/phone (getUser +
// profile read + computeOnboarding). Two server executions, and the
// second answered a question the page that rendered THIS step had already
// answered — the step list is path-fixed, so step N knows step N+1.
// Reported as "it loaded quite a while to get to the cell number one".
//
// The page computes it with pathAfterStep(); see the note there for why
// this is a shortcut that cannot go wrong, only be redundant.

export default function VerifyEmailStepClient({
  email,
  next,
}: {
  email: string;
  next: string;
}) {
  return <VerifyEmailForm email={email} next={next} />;
}
