// ─── Carrying a referral code from a cold click to a real account ─────────
//
// The gap this bridges: someone taps a friend's link, reads the landing page,
// leaves, comes back two days later, signs up, verifies an email OTP, and
// completes four onboarding steps. The code was in the URL at the very first
// step and is nowhere near any of the others. Something has to hold it.
//
// It is a cookie, and it is deliberately the SAME SHAPE as the invitation
// cookie that already does this job for a bill (`hnpl_invite_token`, set in
// app/signup/patient/actions.ts and spent in proxy.ts). One mechanism, one
// posture, one place to review — rather than a second scheme that has to be
// re-reasoned about.
//
// ─── THE POSTURE, AND WHY EACH FLAG ──────────────────────────────────────
//
//   httpOnly   No script reads it. The value is not secret in any strong
//              sense — the person holding it just read it off a URL — but a
//              cookie no script touches is a cookie no third-party script
//              can exfiltrate or overwrite, and this one decides who gets
//              credited for a customer.
//   sameSite   'lax'. The arrival is a top-level GET from WhatsApp, an SMS,
//              or a mail client; 'strict' drops the cookie on exactly that
//              hop and would break the only journey this exists for.
//   secure     Production only, so local development over http still works.
//   path '/'   The proxy reads it on every authenticated request, and the
//              journey crosses /, /signup, /onboarding and /patient.
//
// ─── AND WHY THIRTY DAYS ─────────────────────────────────────────────────
//
// The same window the invitation itself gets (REFERRAL_INVITE_TTL_DAYS), for
// the same reason: a referral has nothing hanging on it, so the honest limit
// is "how long is it still plausibly the reason this person joined". Past
// that the cookie is a stale attribution, and a stale attribution credits the
// wrong person — which is worse than crediting nobody.
//
// ─── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────
//
// It does not decide whether a code is claimable. That is `claimReferral`
// (./claim.ts), which needs the database: self-referral, an account that has
// already been attributed, a revoked code, and a code that does not exist all
// look identical from here.

import { REFERRAL_INVITE_TTL_DAYS } from './vocabulary';

/** The cookie name. Prefixed like every other first-party cookie here. */
export const REFERRAL_COOKIE = 'hnpl_referral';

export const REFERRAL_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * REFERRAL_INVITE_TTL_DAYS;

export type ReferralCookieOptions = {
  httpOnly: true;
  sameSite: 'lax';
  secure:   boolean;
  path:     '/';
  maxAge:   number;
};

/**
 * The cookie options, in one place.
 *
 * `isProduction` is a parameter rather than a read of process.env so this
 * stays a pure function that a test can pin in both modes — the flag that
 * matters most (secure) is the one that is hardest to observe in the
 * environment a test runs in.
 */
export function referralCookieOptions(isProduction: boolean): ReferralCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure:   isProduction,
    path:     '/',
    maxAge:   REFERRAL_COOKIE_MAX_AGE_SECONDS,
  };
}
