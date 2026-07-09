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
// The only onboarding-specific choice is `next="/onboarding"` so that
// on success the browser hard-navigates back to the router page, which
// recomputes the state and forwards to the next unfinished step.

export default function VerifyEmailStepClient({ email }: { email: string }) {
  return <VerifyEmailForm email={email} next="/onboarding" />;
}
