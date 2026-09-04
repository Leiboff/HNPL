'use server';

import { cookies } from 'next/headers';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { getPaymentProvider } from '@/lib/payments/provider';
import { checkoutRef } from '@/lib/payments/peach/refs';
import { encryptId, hashIdForLookup } from '@/lib/idEncryption';
import { findPatientBySaId } from '@/lib/patients/findPatientBySaId';
import { TERMS_VERSION } from '@/lib/legal/terms';
import { consentColumns } from '@/lib/legal/documentHash';
import { PRIVACY_VERSION } from '@/lib/legal/privacy';
import {
  isAllowedSalaryDay,
  ALLOWED_SALARY_DAYS,
} from '@/lib/salaryDates';
import {
  normalizePhoneZA,
  validateSaId,
  saIdAge,
  isValidEmail,
  type SaIdInvalidReason,
} from '@/lib/validation';
import { decryptId } from '@/lib/idEncryption';
import { findExistingAuthUser } from '@/lib/auth/findExistingAuthUser';
import { isPatientFrozen } from '@/lib/patient/freeze';
import { computeOnboarding, type ProfileForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import { claimCreditForPlan } from '@/lib/underwriting/claimCredit';
import { consumeAll, clientIp, RATE_LIMITS } from '@/lib/security/rateLimit';
import { evaluateRisk, mayProceed } from '@/lib/risk/evaluate';
import { generateTempPassword } from '@/lib/auth/tempPassword';
import { generateOtpCode, hashOtpCode } from '@/lib/sms/otp';
import { sendSms, buildOtpSmsBody } from '@/lib/sms/smsportal';
import { discriminateExistingUser } from './_lib/discriminate';
import { isRapidRepeatPayAttempt } from './_lib/idempotency';

// ─── Anonymous checkout — server actions ───────────────────────────────────
//
// initiateCheckout
//   The pivotal "commit" step. Up until this point the visitor is
//   anonymous. Here we:
//     1) Find or create the auth user (no OTP — email is verified by
//        the fact that they clicked the emailed link).
//     2) Write the profile with their details (SA ID encrypted).
//     3) Move the plan to pending_first_payment + record their salary
//        day + plan_type + first instalment amount.
//     4) Create the payments schedule (#1 processing, 2..N scheduled).
//     5) Sign them in via a temp password we just set on the auth user
//        — so they're authenticated when they return from Peach.
//     6) Mint a Peach Checkout V2 session with our callback URL and
//        return the redirect URL for the client to redirect to.
//
//   The "temp password" approach lets us establish a real session
//   without OTP or magic-link side effects. The patient sets their own
//   password on the /checkout/[token]/done step, which overwrites it.
//
//   Idempotency / retry: every step is safe to re-run. If the same
//   patient hits Pay again after a decline, we reuse the same account,
//   update the profile (in case they corrected something), regenerate
//   the temp password + Peach reference, and re-initiate.
//
//   The invitation `accepted_at` is NOT set here — that's the Peach
//   return/webhook's job, after the charge actually succeeds.

const MIN_AGE = 18;

// ─── Fresh-checkout reuse signal ───────────────────────────────────────
// initiateCheckout mints a V2 checkout and stamps its id on the
// instalment-1 row. The very next step is the ResumeCapture confirm →
// Pay, which should REUSE that same checkout so the normal flow makes
// exactly ONE createCheckout. We can't tell "reuse the stamped checkout"
// (fresh, seconds old) from "the stamped checkout is stale" (a re-entry
// via the emailed link days later — a Peach checkout session has a short
// validity window) from the DB alone: the payments row has no
// updated_at, and peach_checkout_id persists on an uncaptured plan.
//
// So initiateCheckout drops a short-lived cookie carrying the fresh
// checkoutId. resumeFirstInstalmentCapture reuses the stamped checkout
// ONLY when this cookie is present AND matches — i.e. we're in the same
// fresh journey. On a genuine re-entry the cookie has expired, so the
// action mints fresh (the deterministic ref stays the dedup net). This
// replaces the earlier query-param hand-off signal, with no auto-start UI.
const FRESH_CHECKOUT_COOKIE   = 'hnpl_fresh_checkout';
const FRESH_CHECKOUT_MAX_AGE_S = 15 * 60; // conservative vs the V2 checkout session TTL

// generateTempPassword now lives in lib/auth/tempPassword.ts — the
// helper has to guarantee a string that satisfies Supabase's project
// password policy (lowercase, uppercase, digit, symbol) because the
// admin auth API runs the policy check on this internal-plumbing
// password too. See that file for the full reasoning.

function saIdErrorMessage(reason: SaIdInvalidReason): string {
  switch (reason) {
    case 'length':      return 'SA ID number must be 13 digits.';
    case 'format':      return 'SA ID number must contain only digits.';
    case 'date':        return 'That ID number\'s date of birth isn\'t a real calendar date.';
    case 'citizenship': return 'That ID number\'s citizenship digit isn\'t recognised.';
    case 'checksum':    return 'That ID number\'s check digit doesn\'t match — please double-check what you typed.';
  }
}

/**
 * The ID typed here is not the one the practice put on this bill.
 *
 * Says nothing about the other value — not the ID, not who it belongs to,
 * not whether it matches an account. The practice can see both; the person
 * on this form cannot, and a payment page is not the place to teach anyone
 * a digit of someone else's ID number.
 *
 * Both onward routes are real: the patient re-reads their card, or the
 * practice re-issues. Neither is a corridor with a wall at the end.
 */
const BILL_ID_MISMATCH_MESSAGE =
  'The ID number you entered doesn’t match the one on this bill. Check the ID number on '
  + 'your card — if it’s right, ask the practice to re-issue the bill.';

export type InitiateCheckoutInput = {
  token:       string;
  firstName:   string;
  lastName:    string;
  // For a POS session token (checkout_sessions), the SA ID is already
  // known server-side and this is ignored — send ''. For an invitation
  // token it's the patient-typed value, validated below as before.
  saIdNumber:  string;
  phone:       string;
  planType:    2 | 3;
  // Post-0065: salary day is a PROFILE-first source of truth. The
  // client sends this only when the patient has no salary_day on
  // their profile yet (new signup or legacy edge). If both the
  // profile and this field are unset, the server returns
  // `missing_salary_day` and the client shows an inline prompt.
  salaryDay?:  number | null;
  // Required ONLY for a POS session token — an invitation token
  // resolves email server-side and this is ignored if sent.
  email?:      string;
  // The checkout "I agree" tick. Required, and checked server-side —
  // see the gate at the top of initiateCheckout for why it has to
  // travel rather than being inferred from the form having rendered.
  termsAccepted: boolean;
};

// ─── Polymorphic token resolution ─────────────────────────────────────
//
// A /checkout/[token] token is either an emailed patient_invitations
// token or a POS counter checkout_sessions token (migration 0085) —
// see the practice-bill-POS-checkout investigation for why these are
// separate tables rather than one overloaded model. Both
// initiateCheckout and resumeFirstInstalmentCapture need "which plan/
// practice does this token point at", so the lookup is shared here.
type ResolvedCheckoutToken =
  // saIdNumber is the ID the PRACTICE typed when issuing the bill, still
  // ENCRYPTED. NULL on invitations issued before migration 0098, which had
  // no such column — a permanent possibility, not a transient one.
  | { kind: 'invitation'; planId: string; practiceId: string; email: string; saIdNumber: string | null }
  // saIdNumber is still ENCRYPTED (v1: format) — the caller decrypts.
  | { kind: 'session';    planId: string; practiceId: string; saIdNumber: string };

async function resolveCheckoutToken(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  token: string,
): Promise<ResolvedCheckoutToken | null> {
  const { data: invitation } = await svc
    .from('patient_invitations')
    .select('plan_id, practice_id, email, sa_id_number')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .is('accepted_at', null)
    .maybeSingle();
  if (invitation) {
    return {
      kind:       'invitation',
      planId:     invitation.plan_id as string,
      practiceId: invitation.practice_id as string,
      email:      (invitation.email as string).trim().toLowerCase(),
      saIdNumber: (invitation.sa_id_number as string | null) ?? null,
    };
  }

  // Lazy fail-safe (Build C): a session nobody explicitly closed still
  // promptly declines its plan the moment anyone next touches this
  // token — including a retried/replayed initiateCheckout call that
  // bypasses the get_checkout_session_by_token RPC entirely. Best-effort
  // — this resolver's own WHERE clause below already excludes an
  // expired session regardless of whether this call succeeds.
  try {
    await svc.rpc('expire_stale_checkout_session', { p_token: token });
  } catch (err) {
    console.warn('[checkout] expire_stale_checkout_session (lazy) failed (non-fatal)',
      err instanceof Error ? err.message : err);
  }

  const { data: session } = await svc
    .from('checkout_sessions')
    .select('plan_id, practice_id, sa_id_number')
    .eq('token', token)
    .in('stage', ['created', 'scanned'])
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (session) {
    return {
      kind:       'session',
      planId:     session.plan_id as string,
      practiceId: session.practice_id as string,
      saIdNumber: session.sa_id_number as string,
    };
  }

  return null;
}

/**
 * Is this patient allowed to pay yet?
 *
 * The same question `requireOnboarded` asks in app/patient/actions.ts, and
 * deliberately the same answer: one call to `computeOnboarding` over the same
 * profile columns and the same feature flags. Duplicating the STEP LIST here
 * would let the two doors drift again, which is what audit A-05 was.
 *
 * `isNewUser` short-circuits: an account created moments ago has no identity
 * verification and no credit check by definition, so there is nothing to read
 * and the answer is the first step of the flow.
 */
async function checkoutOnboardingStatus(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  userId: string,
  isNewUser: boolean,
): Promise<{ done: boolean; path: string }> {
  if (isNewUser) return { done: false, path: '/onboarding' };

  const { data: authUser } = await svc.auth.admin.getUserById(userId);
  const { data: profile } = await svc
    .from('profiles')
    .select(
      'phone_verified_at, sa_id_number, salary_day, salary_amount, '
      + 'credit_check_status, liveness_verified_at, onboarding_completed',
    )
    .eq('id', userId)
    .maybeSingle();

  if (!profile) return { done: false, path: '/onboarding' };

  const status = computeOnboarding(
    {
      email_confirmed_at: authUser?.user?.email_confirmed_at ?? null,
      identity_providers: (authUser?.user?.identities ?? []).map(
        (i: { provider: string }) => i.provider,
      ),
    },
    profile as unknown as ProfileForOnboarding,
    currentFlags(),
  );

  if (status.done) return { done: true, path: '/patient' };
  return { done: false, path: `/onboarding/${status.step}` };
}

/**
 * The ONE refusal for "this bill belongs to an account — sign in".
 *
 * Extracted so the three call sites that used to word it three different
 * ways cannot drift apart again. On the POS/QR door the wording says nothing
 * about whether an account exists at the address supplied, whether it is the
 * account on the bill, or whether the ID number matched — all three were
 * distinguishable before, and together they let a QR-token holder walk a
 * candidate email list (audit A-03).
 *
 * ─── WHY THE SA-ID COPY SURVIVES ON THE INVITATION DOOR ─────────────────
 *
 * The specific "an account already exists for this ID number" message is a
 * deliberate disclosure, argued for at its call site: it is what lets a real
 * returning patient understand why they cannot pay, and the alternative
 * strands them. What made it a problem is the OTHER door. On a POS/QR token
 * the email is the caller's choice, so with the bill's SA ID fixed, "ID
 * duplicate" versus "sign in" told a caller whether the address they probed
 * held an account — a two-outcome enumeration oracle, from a surface a
 * merchant can POST to in a loop.
 *
 * On an invitation the email is not the caller's choice; it comes off the
 * invitation row. There is nothing to enumerate, so the disclosure costs
 * nothing and the UX argument stands unopposed. Hence: keyed on the door.
 *
 * The session door does not strand anybody either. Its `next` is the
 * checkout page, which for a signed-in patient claims the plan by SA ID and
 * forwards to /confirm — so the generic message plus a Log in button is a
 * complete path, not a dead end.
 */
function signInRequired(
  token:     string,
  planId:    string,
  tokenKind: 'invitation' | 'session',
  opts:      { saIdDuplicate?: boolean } = {},
): InitiateCheckoutResult {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const next   = tokenKind === 'session'
    ? `/checkout/${encodeURIComponent(token)}`
    : `/patient/orders/${planId}/confirm`;
  const error  = opts.saIdDuplicate && tokenKind === 'invitation'
    ? 'An account already exists for this ID number. Please log in to that '
      + 'account to continue — or use "Forgot password" if you can\'t get in.'
    : 'Please sign in to continue with this bill.';
  return {
    ok:           false,
    error,
    requireLogin: true,
    loginUrl:     `${appUrl}/login?next=${encodeURIComponent(next)}`,
  };
}

export type InitiateCheckoutResult =
  | {
      ok:                  true;
      // Peach Checkout V2: the widget script is loaded with this id and
      // renders the card entry / 3DS UI in-page. No off-site redirect.
      checkoutId:          string;
      // Server-computed instalment 1 amount in cents. Displayed to the
      // patient (for confirmation) but the value the widget POSTs to
      // Peach is bound to `checkoutId` on the server side — the client
      // cannot mutate it.
      amountCents:         number;
      // Where the widget should POST on completion. Encoded so the
      // return route can look up the plan without another round-trip.
      shopperResultUrl:    string;
    }
  | { ok: false; error: string }
  // requireLogin fires for the organic-account email collision case
  // (#6 in the verification audit). The form uses `loginUrl` to send
  // the patient to /login?next=… so they land on this bill's
  // confirm page after authenticating.
  | { ok: false; error: string; requireLogin: true; loginUrl: string }
  // frozen fires when the resolved patient has an unresolved defaulted
  // plan — they're blocked from starting a new one until it's settled.
  | { ok: false; error: string; frozen: true }
  // requireOnboarding fires when the patient's identity verification or
  // credit check has not passed (product decision 2026-09-02, audit A-05).
  // `error` is the stable code 'verification_required'; the form sends them
  // to `onboardingUrl`, which returns to this same checkout token when done.
  | { ok: false; error: string; requireOnboarding: true; onboardingUrl: string };

export async function initiateCheckout(input: InitiateCheckoutInput): Promise<InitiateCheckoutResult> {
  const { token, firstName, lastName, phone, planType, termsAccepted } = input;
  const clientSalaryDay: number | null =
    typeof input.salaryDay === 'number' ? input.salaryDay : null;

  // ── The acceptance is a SERVER decision ─────────────────────────────
  //
  // This action is the THIRD way to get an account on this system — it
  // runs svc.auth.admin.createUser for a patient who has never signed up
  // — and it was the only one whose "I agree" tick was never checked
  // here. CheckoutForm validates it client-side and did not send it, yet
  // the profile upsert below stamps profiles.terms_accepted_at
  // unconditionally. So a request that skipped the form entirely got an
  // account AND an audit record saying they had agreed.
  //
  // That is exactly the defect migration 0081 was written to close, still
  // open on this path: its own header says the checkout tick was
  // "captured CLIENT-SIDE ONLY". 0081 made the acceptance RECORDED; this
  // makes it REQUIRED, which is the half that makes the record mean
  // something.
  //
  // Checked first, before the token is even resolved, for the same reason
  // signUpPatient checks it first: no account, no plan and no OTP should
  // exist for a request that was never entitled to make one.
  //
  // `!== true` rather than `!termsAccepted` — a Server Action is an HTTP
  // endpoint, the `boolean` annotation is erased at runtime, and every
  // truthy non-boolean (the string "false" among them) would otherwise
  // pass. Same posture as signUpPatient and as /auth/callback's
  // `terms_accepted === '1'`. Enumerated in
  // app/checkout/[token]/checkout-terms-bypass.adversarial.test.ts.
  if (termsAccepted !== true) {
    return { ok: false, error: 'Please accept the payment-plan terms to continue.' };
  }

  if (!token)                  return { ok: false, error: 'Missing token.' };

  // ── Rate limit (audit F-17) ─────────────────────────────────────────
  //
  // Unauthenticated, and a successful call creates an auth user and mints
  // a Peach checkout. Keyed per-IP and per TOKEN: the token key is the
  // interesting one, because it bounds what a leaked or shared checkout
  // link can be made to do independently of where the requests come from.
  if (!await consumeAll('checkout_initiate', [
    [await clientIp(), RATE_LIMITS.checkout_initiate.ip],
    [token,                         RATE_LIMITS.checkout_initiate.account!],
  ])) {
    return { ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' };
  }

  if (!firstName.trim())       return { ok: false, error: 'First name is required.' };
  if (!lastName.trim())        return { ok: false, error: 'Last name is required.' };

  const normalizedPhone = normalizePhoneZA(phone);
  if (!normalizedPhone) return { ok: false, error: 'Enter a valid South African cellphone number.' };

  if (planType !== 2 && planType !== 3) return { ok: false, error: 'Pick 2 or 3 instalments.' };
  // Client-supplied salary day (when present) must be allowed. Blank
  // is fine — we'll try to source it from the profile below.
  if (clientSalaryDay !== null && !isAllowedSalaryDay(clientSalaryDay)) {
    return { ok: false, error: `Salary day must be one of: ${ALLOWED_SALARY_DAYS.join(', ')}.` };
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // ── 1. Resolve the token — invitation OR POS session ──────────────────
  const resolved = await resolveCheckoutToken(svc, token);
  if (!resolved) return { ok: false, error: 'This checkout link is no longer valid.' };

  // ── Aggregate risk (audit 2026-09-03, S-07) ─────────────────────────
  //
  // The third door onto an account on this system, and the one an attacker
  // reaches with a bill token rather than a signup form. The bucket above
  // bounds one IP and one token; it cannot see one device walking a
  // hundred different tokens, or one practice converting bill tokens at a
  // rate no clinic works at — which is the merchant side of the collusion
  // the audit describes.
  //
  // Placed here, after the token resolves and before any account or plan
  // is created, because the practice is the signal that matters most on
  // this surface and it is not known until the token has been read.
  const risk = await evaluateRisk({
    event:      'checkout_initiate',
    practiceId: resolved.practiceId,
    phone:      normalizedPhone,
  });
  if (!mayProceed(risk)) return { ok: false, error: risk.refusalMessage! };

  // saIdNumber source + validation forks on token kind:
  //   • invitation — patient-typed, validated here as always, and since
  //     0098 CHECKED against the ID the practice put on the bill.
  //   • session    — already captured + validated at the till; decrypt
  //     the session's stored value server-side and IGNORE whatever the
  //     client sent for saIdNumber (the field is locked/masked on the
  //     phone-side form — see CheckoutForm's prefilledSaId). Re-run the
  //     same validate+age checks defensively; they should always pass
  //     since issueCounterSession already ran them at issuance.
  let saIdPlain: string;
  let normalizedEmail: string;
  if (resolved.kind === 'invitation') {
    const saIdResult = validateSaId(input.saIdNumber);
    if (!saIdResult.valid) return { ok: false, error: saIdErrorMessage(saIdResult.reason) };
    const age = saIdAge(input.saIdNumber);
    if (age === null || age < MIN_AGE) {
      return { ok: false, error: `You must be ${MIN_AGE} or older to accept a payment plan.` };
    }
    // ── The bill's own ID has to agree with the one being typed ────────
    //
    // Until 0098 the email path validated this ID and then discarded it,
    // so a practice could bill under one ID and the patient claim under
    // another with nothing noticing. The QR path never had that gap: it
    // decrypts the session's stored value and ignores the client's
    // entirely.
    //
    // Compared rather than overridden, because unlike the till the patient
    // is remote and the field is theirs to fill — so a disagreement is
    // something to surface, not to silently overwrite.
    //
    // Same discipline as claimUnboundSessionPlan: decrypt both sides,
    // compare PLAINTEXT (two encryptions of one ID differ), fail CLOSED on
    // anything unreadable, and say nothing about the other value.
    if (resolved.saIdNumber) {
      let billSaId: string;
      try {
        billSaId = decryptId(resolved.saIdNumber).trim();
      } catch (err) {
        console.error('[checkout] failed to decrypt invitation SA ID',
          err instanceof Error ? err.message : err);
        return { ok: false, error: 'Encryption error — please contact support.' };
      }
      if (!billSaId || billSaId !== input.saIdNumber.trim()) {
        return { ok: false, error: BILL_ID_MISMATCH_MESSAGE };
      }
    }

    saIdPlain       = input.saIdNumber;
    normalizedEmail = resolved.email;
  } else {
    try {
      saIdPlain = decryptId(resolved.saIdNumber);
    } catch (err) {
      console.error('[checkout] failed to decrypt session SA ID', err instanceof Error ? err.message : err);
      return { ok: false, error: 'Encryption error — please contact support.' };
    }
    const saIdResult = validateSaId(saIdPlain);
    if (!saIdResult.valid) return { ok: false, error: saIdErrorMessage(saIdResult.reason) };
    const age = saIdAge(saIdPlain);
    if (age === null || age < MIN_AGE) {
      return { ok: false, error: `You must be ${MIN_AGE} or older to accept a payment plan.` };
    }
    const emailInput = (input.email ?? '').trim().toLowerCase();
    if (!isValidEmail(emailInput)) return { ok: false, error: 'Enter a valid email address.' };
    normalizedEmail = emailInput;
  }

  // ── 2. Fetch the plan (need plan.patient_id BEFORE the user decision) ─
  // Why early: the discriminator below uses plan.patient_id to tell
  // "returning checkout patient" (reuse) apart from "organic-account
  // email collision" (reject with login guidance). The previous order
  // (auth lookup first, decide on email_confirmed_at alone) broke
  // decline-retry — see app/checkout/[token]/_lib/discriminate.ts.
  const { data: plan } = await svc
    .from('plans')
    .select('id, total_amount, status, application_id, practice_id, patient_id, peach_registration_id')
    .eq('id', resolved.planId)
    .maybeSingle();

  if (!plan) return { ok: false, error: 'This bill no longer exists.' };

  // ── 2a. Which plan states may run this action ────────────────────────
  //
  // THIS USED TO BE A DENY-LIST of completed/cancelled/declined, which let
  // an ACTIVE, already-paid, already-paid-out plan straight through to
  // step 6 — where the schedule, including its `collected` instalment 1,
  // was deleted and rewritten and the plan pushed back to
  // pending_first_payment (audit F-06).
  //
  // That was reachable, not theoretical. The invitation's accepted_at and
  // the POS session's terminal stage are stamped by the BROWSER return
  // page; when the Peach webhook wins the activation race instead — the
  // patient closed the tab, lost signal, or pressed back — neither is
  // written and the token stays live for the rest of its 7-day TTL. Re-open
  // the emailed link, let a card decline, and handlePaymentFailure cancels
  // the plan while the payouts row (UNIQUE on plan_id, never reversed) has
  // already paid the practice 94%.
  //
  // (activateFirstInstalment now closes the token itself, so the window is
  // shut from the other end too. Both halves are kept: this one is the
  // guard, that one removes the opportunity.)
  //
  // The allow-list is the two states that genuinely belong here:
  //
  //   pending_acceptance     — a fresh arrival.
  //   pending_first_payment  — a genuine re-entry by an abandoner, which
  //                            this action supports on purpose (they may
  //                            change 2↔3, so the schedule IS rewritten).
  //                            Admitted ONLY while the card was never
  //                            captured and nothing was ever collected.
  //
  // Anything else — active, defaulted, completed, cancelled, declined —
  // has money or a decision attached to it and does not get its ledger
  // rewritten by a token holder.
  const ACCEPTABLE_ENTRY_STATES = ['pending_acceptance', 'pending_first_payment'];
  if (!ACCEPTABLE_ENTRY_STATES.includes(plan.status as string)) {
    return { ok: false, error: 'This bill has already been settled or cancelled.' };
  }

  if (plan.status === 'pending_first_payment') {
    if (plan.peach_registration_id) {
      // A stored card means the CIT landed (or is in flight). Re-entry
      // belongs on resumeFirstInstalmentCapture, which rewrites nothing.
      return { ok: false, error: 'This bill is already being paid. Please check your orders.' };
    }
    const { data: settled } = await svc
      .from('payments')
      .select('id')
      .eq('plan_id', plan.id)
      .in('status', ['collected', 'defaulted'])
      .limit(1);
    if (settled && settled.length > 0) {
      // Belt-and-braces against the registration-id stamp having been
      // missed: money that has moved is never deleted and re-created.
      //
      // 'processing' is deliberately NOT in this list. It is the status
      // initiateCheckout itself writes for instalment 1, so every genuine
      // abandoner is sitting in it — refusing on it would have broken the
      // one re-entry this action exists to support (a patient who dropped
      // out at the widget, lost their cookie, and comes back through the
      // emailed link, possibly switching 2↔3).
      //
      // Safe to allow because of what it is paired with: no
      // peach_registration_id. A CIT that actually landed stamps that id
      // on BOTH completion paths — the browser return page and the webhook
      // — so "no registration id and nothing collected" is a charge that
      // demonstrably did not complete, whatever its row still says.
      return { ok: false, error: 'This bill is already being paid. Please check your orders.' };
    }
  }

  // ── 2b. Idempotency: short-window pay-step throttle ──────────────────
  // If a previous Pay submit stamped a Peach reference on this
  // plan's instalment 1 in the last 5s, we're in a rapid retry (e.g.
  // slow Peach roundtrip → user refreshed → second submit). The
  // discriminator below would handle this correctly — same user, same
  // plan, wipe-and-recreate payments — but doing that work twice in
  // 5s thrashes the DB and risks ordering surprises (the first call's
  // payments row is in the middle of being read by Peach as we
  // delete it). Throttle instead; the user just waits a beat.
  const { data: recentInstalmentOne } = await svc
    .from('payments')
    .select('created_at, peach_payment_id')
    .eq('plan_id', plan.id)
    .eq('instalment_number', 1)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (isRapidRepeatPayAttempt(recentInstalmentOne, Date.now())) {
    return {
      ok:    false,
      error: 'Just a moment — your last attempt is still being processed. Please wait a few seconds before trying again.',
    };
  }

  // ── 2c. Phone-verification precondition ───────────────────────────────
  // The patient must have verified the entered phone within the last
  // 30 minutes. We never create an account / charge a card / claim an
  // invitation for a number we haven't proven control of. The 30-min
  // freshness defends against a "verified yesterday, walked away,
  // came back" replay — re-verifying takes one SMS and is fast.
  //
  // Service-role bypasses RLS on phone_verifications (which has no
  // anon policies — see migration 0052). The verified_at value we
  // read here gets re-applied to profiles inside the atomic commit
  // below, so the verification fact lands together with everything
  // else this action writes.
  const PHONE_VERIFY_FRESHNESS_MS = 30 * 60 * 1000;
  const freshnessCutoff = new Date(Date.now() - PHONE_VERIFY_FRESHNESS_MS).toISOString();
  const { data: verification } = await svc
    .from('phone_verifications')
    .select('verified_at')
    .eq('invitation_token', token)
    .eq('phone_e164',       normalizedPhone)
    .not('verified_at', 'is', null)
    .gt ('verified_at', freshnessCutoff)
    .maybeSingle();

  if (!verification?.verified_at) {
    // Client maps this code to "bounce back to the Verify step".
    return { ok: false, error: 'verify_phone_required' };
  }
  const phoneVerifiedAt = verification.verified_at as string;

  // ── 3. Find existing user, then route via the plan-ownership rule ────
  let userId:      string;
  let isNewUser:   boolean = false;

  const existing = await findExistingAuthUser(svc, normalizedEmail);
  const decision = discriminateExistingUser(
    existing,
    (plan.patient_id as string | null) ?? null,
    resolved.kind,
  );

  if (decision.action === 'require-login') {
    // ── The A-03 refusal ──────────────────────────────────────────────
    //
    // Covers two cases that used to be three messages:
    //
    //   • an email collision with an organic BetterNow account (the #6
    //     race), which this always refused; and
    //   • ANY pre-existing account reached through a POS/QR token, which it
    //     used to hand a session to. On that path the token is on the
    //     practice's screen and the email is in the request body, so
    //     "reuse the account at this address" meant a merchant could name a
    //     customer and get a session as them — with the customer's password
    //     reset out from under them on the way. See _lib/discriminate.ts.
    //
    // ONE message for both, and for the SA-ID collision below. The three
    // distinct strings this used to emit were a working oracle: an attacker
    // holding a QR token could tell "wrong-but-real address" from "unknown
    // address" from "the address on this bill", and walk a candidate list
    // until one came back different.
    //
    // WHERE they land after logging in forks on the token kind, because the
    // confirm page can only render a plan that already has an owner:
    //
    //   invitation — createBill stamped plans.patient_id at creation when an
    //                account existed, so /confirm works and is the shorter hop.
    //   session    — a till bill may have NO owner yet, so /confirm would find
    //                nothing and dump them on /patient/orders with the bill
    //                nowhere in sight, at the counter, mid-transaction. Send
    //                them back to the checkout page instead: with a session it
    //                claims the plan for them (SA ID matched) and forwards to
    //                /confirm itself.
    return signInRequired(token, plan.id as string, resolved.kind);
  }

  // ── 3-bis. One SA ID = one patient account (migration 0097) ──────────
  //
  // Refused HERE, before any account is created, for two reasons: a
  // rejection after createUser would leave an orphan auth user, and the
  // unique index would reject the profile upsert far downstream with a
  // raw Postgres error the patient cannot act on. The index is still the
  // authority — this is the message, not the enforcement.
  //
  // ON SAYING "an account already exists for this ID" OUT LOUD
  //   This DELIBERATELY diverges from findExistingAuthUser's posture, which
  //   never confirms whether an email is registered. Do not "fix" it for
  //   consistency — the divergence is the decision, not an oversight.
  //
  //   AMENDED 2026-09-02 (audit A-03): the divergence now holds only on the
  //   INVITATION door. On a POS/QR token the email is the caller's choice, so
  //   with the bill's SA ID fixed this message versus the generic one told a
  //   caller whether a probed address held an account. Both halves of the
  //   reasoning below are about a person at a counter with an ID in hand —
  //   which is exactly the emailed door's caller and not the QR holder's.
  //
  //   Two reasons it is right here and not there. First, the disclosure is
  //   marginal: an SA ID reaches this action because a person physically
  //   presented it at a counter and a receptionist typed it, or because
  //   they typed their own. Email enumeration is a remote, scriptable probe
  //   against arbitrary addresses; this is not. Second, the alternative is
  //   worse than the leak. A vague refusal strands a REAL returning patient
  //   at a till with no idea why they cannot pay and no next step, which is
  //   the exact failure this whole flow keeps having to be rescued from.
  //   Naming the situation is what lets them act on it.
  //
  // Self-exclusion: the person re-submitting their OWN ID must pass. On
  // the 'reuse' fork we already know which account this checkout resolves
  // to, so an owner that IS that account is not a duplicate. On
  // 'create-new' there is no account yet, so ANY owner is somebody else.
  {
    const prospectiveUserId = decision.action === 'reuse' ? decision.userId : null;
    let idOwner: Awaited<ReturnType<typeof findPatientBySaId>> = null;
    try {
      idOwner = await findPatientBySaId(svc, saIdPlain);
    } catch (err) {
      // A failed lookup is not permission to proceed — it is the one case
      // where continuing could create the duplicate this exists to stop.
      console.error('[checkout] SA ID duplicate check failed:', err instanceof Error ? err.message : err);
      return { ok: false, error: 'We could not verify your ID number just now. Please try again.' };
    }

    if (idOwner && idOwner.id !== prospectiveUserId) {
      // Names the situation on the emailed door and stays generic on the
      // POS/QR one — see signInRequired for why the door is what decides.
      // Three distinguishable refusals here were an oracle (audit A-03), and
      // this is the one of the three whose disclosure is worth its cost.
      return signInRequired(token, plan.id as string, resolved.kind, { saIdDuplicate: true });
    }
  }

  if (decision.action === 'reuse') {
    userId = decision.userId;
  } else {
    // 'create-new' — fresh creation. email_confirm: true skips
    // Supabase's signup OTP entirely; the emailed-link click IS our
    // verification.
    const tempPwd = generateTempPassword();
    const { data: created, error: createErr } = await svc.auth.admin.createUser({
      email:          normalizedEmail,
      password:       tempPwd,
      email_confirm:  true,
      user_metadata:  {
        role:                   'patient',
        invited_by_practice_id: resolved.practiceId,
      },
    });
    if (createErr || !created.user) {
      return { ok: false, error: createErr?.message ?? 'Failed to create account.' };
    }
    userId    = created.user.id;
    isNewUser = true;
  }

  // ── 3a. Default freeze (server-side gate). A returning patient with an
  //    unresolved defaulted plan is blocked from starting a NEW one until
  //    they settle it. New users can't be frozen (no prior plans), so we
  //    skip the query for them. This is the authoritative enforcement —
  //    the checkout/orders UI also surfaces it, but the block lives here
  //    so a direct POST cannot bypass it. Mirrors the bill-acceptance
  //    reject pattern above.
  if (!isNewUser && (await isPatientFrozen(svc, userId))) {
    return {
      ok:     false,
      error:  "You have a defaulted plan. You can't take on a new plan until it's settled — open your orders to settle it.",
      frozen: true,
    };
  }

  // ── 3a-bis. Credit limit ─────────────────────────────────────────────
  //
  // Nothing here any more, deliberately. This used to be a `checkCreditLimit`
  // read that decided, and then STEP 6 below wrote the schedule — the
  // check→then→write window that audit A-04 exploited on all three
  // acceptance paths. Worse, it was skipped entirely for `isNewUser`, on the
  // reasoning that a user created seconds ago has no limit yet; audit A-05
  // showed that made "be a new user" the way to take on a bill with no
  // ceiling at all, and the account-creation branch above is reachable by
  // choosing an unused email.
  //
  // Both are now the same single fact: `claim_credit_for_plan` (migration
  // 0130) decides and writes the schedule in one transaction under a row
  // lock, for EVERY account, new or returning. A new user with no approved
  // limit is refused `no_limit` there — which is correct and is why the
  // verification gate above exists: a patient reaches this action already
  // ID-verified and credit-checked, so they have a limit by the time they
  // get here.

  // ── 3b. Resolve the salary_day — profile is the source of truth ─────
  // Post-0065 the profile holds the canonical salary_day. Precedence:
  //   1. profile.salary_day if already set (returning patient) —
  //      the client value is IGNORED, defence-in-depth against a
  //      tampered submission.
  //   2. client-supplied value (new signup, or legacy patient
  //      without a stored salary_day).
  //   3. neither → 'missing_salary_day' code so the client can
  //      show the inline picker and retry.
  // For a brand-new patient (decision.action === 'create-new') we
  // don't have a profile row yet — the trigger writes a minimal row
  // but salary_day starts NULL, so we always fall through to the
  // client value.
  const { data: existingProfile } = await svc
    .from('profiles')
    .select('salary_day')
    .eq('id', userId)
    .maybeSingle();
  const profileSalaryDay: number | null =
    (existingProfile?.salary_day as number | null) ?? null;
  const salaryDay: number | null =
    profileSalaryDay != null && isAllowedSalaryDay(profileSalaryDay)
      ? profileSalaryDay
      : clientSalaryDay;
  if (salaryDay === null || !isAllowedSalaryDay(salaryDay)) {
    return { ok: false, error: 'missing_salary_day' };
  }

  // ── 4. Upsert the profile row with the patient's details ──────────────
  // The on_auth_user_created trigger writes a minimal profile when the
  // auth user is created (migration 0033). We update it with the form
  // fields here. For returning patients we always overwrite — they
  // may have corrected a typo.
  let encryptedSaId: string;
  let saIdLookupHash: string;
  try {
    const trimmedSaId = saIdPlain.trim();
    encryptedSaId  = encryptId(trimmedSaId);
    // Deterministic blind index (migration 0096) — the only value on this
    // row that a duplicate SA ID can be recognised by, since the
    // ciphertext above differs on every call. Written in the same try as
    // encryptId because both are the same class of failure (a missing or
    // malformed key) and both must fail CLOSED: a row that lands with a
    // NULL hash is a row the uniqueness constraint cannot see.
    saIdLookupHash = hashIdForLookup(trimmedSaId);
  } catch {
    return { ok: false, error: 'Encryption error — please contact support.' };
  }

  const profileFields = {
    id:                 userId,
    role:               'patient',
    email:              normalizedEmail,
    first_name:         firstName.trim(),
    last_name:          lastName.trim(),
    phone:              normalizedPhone,
    sa_id_number:       encryptedSaId,
    sa_id_lookup_hash:  saIdLookupHash,
    salary_day:         salaryDay,
    // Phone-verification fact lands together with everything else this
    // action writes. Idempotent on retry — upsert re-applies the same
    // verified_at (or a refreshed one if the row was re-verified between
    // retries; we don't ratchet backward).
    phone_verified_at:  phoneVerifiedAt,
    // Checkout-origin patients never pass through signUpPatient, so this
    // is where their account-level acceptance of the T&Cs + Privacy
    // Policy is recorded — the checkout "I agree" tick, stamped
    // server-side with both versions AND both document digests. The tick
    // itself is REFUSED at the top of this action, so reaching here means an
    // agreement the server actually saw, not one inferred from the form
    // having rendered.
    //
    // No server-issued token on this path, and it does not need one (audit
    // A-14): the tick arrives in the SAME request as the acceptance, from a
    // form served by this application at a token this application issued —
    // so there is no gap between "the documents were shown" and "the
    // acceptance was recorded" for a parameter to slip into. The OAuth
    // callback needs the token precisely because its acceptance arrives on a
    // separate request, after a round trip through Google.
    ...consentColumns(),
  };

  // ── Never overwrite an existing account's identity from a QR token ──
  //
  // Unreachable by construction: discriminateExistingUser returns
  // require-login for every pre-existing account on the session path, so
  // reaching here with !isNewUser means the token was an invitation — i.e.
  // a link emailed to this very address, which is the patient editing their
  // own details.
  //
  // Asserted anyway, because the alternative is that this write's safety
  // depends on a rule in another file staying correct. The overwrite of
  // first_name / last_name / phone / phone_verified_at is exactly what audit
  // A-03 used to rewrite a victim's profile, and the property wants to be
  // local to the statement that does it.
  if (!isNewUser && resolved.kind === 'session') {
    console.error('[checkout] ALERT refusing to overwrite an existing profile from a counter session', {
      planId: plan.id,
    });
    return signInRequired(token, plan.id as string, resolved.kind);
  }

  // Use upsert so the path works whether the trigger has populated a row
  // or not — for AUTH_ONLY orphans the profile may not exist.
  const { error: profileErr } = await svc
    .from('profiles')
    .upsert(profileFields, { onConflict: 'id' });
  if (profileErr) {
    if (isNewUser) {
      // No-orphans: tear the auth user back down if we can't get a
      // profile in. Cascade is now in place (migration 0044) so this
      // succeeds even if a minimal trigger row was written.
      await svc.auth.admin.deleteUser(userId).catch(() => {});
    }
    return { ok: false, error: `Failed to save your details: ${profileErr.message}` };
  }

  // ── 5. Bind the plan + application to this patient (idempotent) ──────
  // The plan was already fetched in step 2. Bind only if currently
  // unbound — on a returning-patient retry the binding is already in
  // place from the first pass, and the `.is('patient_id', null)`
  // guard makes this a no-op.
  const planUpdateOk = await svc
    .from('plans')
    .update({ patient_id: userId })
    .eq('id', plan.id)
    .is('patient_id', null);
  if (planUpdateOk.error) {
    return { ok: false, error: `Failed to bind plan: ${planUpdateOk.error.message}` };
  }
  if (plan.application_id) {
    await svc
      .from('applications')
      .update({ patient_id: userId })
      .eq('id', plan.application_id as string)
      .is('patient_id', null);
  }

  // ── 6. THE VERIFICATION GATE ─────────────────────────────────────────
  //
  // Product decision, 2026-09-02: a patient may not PAY before their
  // identity and credit check have passed. Audit A-05 was that this door
  // enforced neither — the in-app door (acceptPlan / payWithSavedCard) runs
  // requireOnboarded, which covers email, phone, salary, IDENTITY, LIVENESS
  // and the credit check, and this one ran a phone check and nothing else.
  // So a stolen SA ID number plus a phone the caller controls was enough to
  // take a plan, and HNPL paid the practice 94% of it on first-payment
  // success.
  //
  // The fix is not another copy of those gates. It is that this action stops
  // being a second front door: it identifies the patient and binds the plan,
  // and then hands off to the flow that already enforces everything. Nothing
  // below this point runs until onboarding is complete — no schedule, no
  // Peach checkout, no charge.
  //
  // A brand-new account is by definition not onboarded, so a first-time
  // patient at the counter is routed through Didit and the credit check and
  // comes back to the same token. The token is still live (activation is
  // what closes it), so the return trip charges normally and still vaults
  // the card in the same step — the one-tap card-and-charge is preserved,
  // it just happens after verification instead of before.
  const onboarding = await checkoutOnboardingStatus(svc, userId, isNewUser);
  if (!onboarding.done) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
    return {
      ok:                false,
      error:             'verification_required',
      requireOnboarding: true,
      onboardingUrl:     `${appUrl}${onboarding.path}?next=${encodeURIComponent(`/checkout/${token}`)}`,
    };
  }

  // ── 7. Claim the credit and write the schedule, in ONE transaction ────
  //
  // Was: splitInstalments, then a plan UPDATE, then a DELETE, then a
  // survivor SELECT, then an INSERT — with the credit decision a hundred
  // lines earlier and skipped entirely for a new account (`if (!isNewUser)`,
  // audit A-05) so a first bill was bounded only by MAX_BILL_AMOUNT.
  //
  // claim_credit_for_plan (migration 0130) does all of it under a lock on
  // the patient's profile row: re-derives exposure, applies the allowance
  // model, deletes only the statuses a never-captured plan can hold, refuses
  // if anything survives that delete (the F-06 guard, now a property of the
  // statement), and inserts the schedule. There is no longer a window in
  // which two callers both see the same headroom (A-04).
  const totalAmount = Number(plan.total_amount);
  const claim = await claimCreditForPlan(svc, {
    planId:         plan.id as string,
    patientId:      userId,
    planType,
    totalAmount,
    salaryDay,
    expectedStatus: plan.status as 'pending_acceptance' | 'pending_first_payment',
    termsVersion:   TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
  });
  if (!claim.ok) return { ok: false, error: claim.message };

  const instalments   = claim.instalments;
  const instalment1Id = claim.instalmentOneId;

  // ── 7b. Stamp the Peach reference on the instalment-1 row ────────────
  // Compact 16-char ref per Peach V2 mandate. Deterministic per
  // instalment-1 payment id so a mid-flight retry Peach-dedups.
  // Webhook echoes it back as merchantTransactionId; reconcile via
  // payments.peach_payment_id.
  const reference = checkoutRef(instalment1Id);
  await svc.from('payments').update({ peach_payment_id: reference }).eq('id', instalment1Id);

  // ── 8. Establish the session — WITHOUT touching the password ──────────
  //
  // THE DEFECT (audit A-03): this used to be
  //
  //     await svc.auth.admin.updateUserById(userId, { password: temp });
  //     await supabaseAuth.auth.signInWithPassword({ email, password: temp });
  //
  // which is fine for an account this call just created and an account
  // takeover for any account it did not: the real owner's password was
  // destroyed (no notification, no way back except a reset) and whoever held
  // the token got a live session as them.
  //
  // A magic link mints the session and mutates nothing — the same shape the
  // F-07 fix already adopted on /checkout/[token]/complete. The token holder
  // still gets a session, but only where that is equivalent to a magic link
  // sent to the address in question: discriminateExistingUser now returns
  // require-login for every pre-existing account on the POS/QR path, so the
  // only accounts reachable here are ones this call created and ones whose
  // own emailed invitation carried the caller.
  const supabaseAuth = await createClient();
  const { data: link, error: linkErr } = await svc.auth.admin.generateLink({
    type:  'magiclink',
    email: normalizedEmail,
  });
  const hashedToken = link?.properties?.hashed_token;
  if (linkErr || !hashedToken) {
    return { ok: false, error: `Failed to establish session: ${linkErr?.message ?? 'no token returned'}` };
  }
  const { error: signInErr } = await supabaseAuth.auth.verifyOtp({
    token_hash: hashedToken,
    type:       'magiclink',
  });
  if (signInErr) return { ok: false, error: `Failed to sign in: ${signInErr.message}` };

  // ── 9. Create the Peach Checkout V2 checkout ─────────────────────────
  // The checkout is created server-side with the amount we just
  // computed. The client receives ONLY a checkoutId to mount the widget
  // against — the amount is bound on the server side and the widget
  // sends it directly to Peach. Client cannot supply / override the
  // amount at any point.
  const appUrl      = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const shopperResultUrl = `${appUrl}/checkout/${token}/complete`;
  const amountCents = Math.round(instalments[0] * 100);

  // Flow A standingInstruction fields per the Peach V2 /v2/checkout
  // schema (developer.peachpayments.com/reference/post_v2-checkout):
  //   expiry               = last instalment date + 30d buffer (yyyy-MM-dd)
  //                          — covers late-collection retries within the
  //                          dunning ladder.
  //   frequency            = INTEGER 1-9999, days between recurring
  //                          authorisations. Our schedule is monthly
  //                          (aligned to salary day) → 30. Prior to
  //                          2026-07-30 this was sent as the string
  //                          '0001' (misread as a Mastercard scheme
  //                          code) which caused Peach V2 to reject
  //                          the whole body with "Invalid request body"
  //                          — the entire checkout initiate failed and
  //                          the widget never mounted.
  //   numberOfInstallments = INTEGER 1-999, REQUIRED for INSTALLMENT +
  //                          INITIAL. planType (2 or 3) is always
  //                          within the allowed range; the previous
  //                          "omit for planType=2" logic mistook the
  //                          Peach Budget Installment scheme's
  //                          acquirer-specific allowed set for the V2
  //                          checkout constraint. Send as planType.
  //   recurringType        = NOT sent for type=INSTALLMENT (only for
  //                          type=RECURRING). Our BNPL is closed-ended
  //                          fixed-count → type=INSTALLMENT covers it.
  const lastInstalmentDate = claim.dueDates[claim.dueDates.length - 1];
  const expiryDate = new Date(lastInstalmentDate.getTime() + 30 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const provider = getPaymentProvider();
  let checkoutId: string;
  try {
    const checkout = await provider.createCheckout({
      amountCents,
      merchantTransactionId: reference,
      currency:              'ZAR',
      paymentType:           'DB',
      createRegistration:    true,   // remember the card for MIT retries
      shopperResultUrl,
      origin:                appUrl,
      // Card-only. Wallet tokens (Apple Pay / Google Pay) are
      // single-use — instalments 2-N would be uncollectable if the
      // first CIT used a wallet. See CheckoutCreateParams for the full
      // rationale.
      defaultPaymentMethod: 'CARD',
      forceDefaultMethod:   true,
      // Peach V2 SI (developer.peachpayments.com/reference/post_v2-checkout).
      // INITIAL + INSTALLMENT — fixed-instalment plan, first CIT
      // capture via the embedded widget. V2 does NOT accept `source`
      // (OPPWA-only vocabulary — the "unknown field" rejection from
      // 2026-07-30). The Checkout V2 door is inherently CIT by design;
      // no source flag needed.
      standingInstruction: {
        mode:                 'INITIAL',
        type:                 'INSTALLMENT',
        expiry:               expiryDate,
        frequency:            30,        // days between authorisations
        numberOfInstallments: planType,  // 2 or 3, both valid (1-999)
      },
      customer: {
        email:     normalizedEmail,
        givenName: firstName.trim(),
        surname:   lastName.trim(),
      },
      customParameters: {
        SHOPPER_purpose:    'checkout_first_payment',
        SHOPPER_token:      token,
        SHOPPER_patientId:  userId,
        SHOPPER_planId:     plan.id as string,
        SHOPPER_paymentId:  instalment1Id,
      },
    });
    checkoutId = checkout.checkoutId;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Payment initialization failed.' };
  }

  // Reconciliation convenience — the checkoutId is the browser-visible
  // handle for this transaction; stamp it on the payment row so admin
  // lookups by checkoutId find the right instalment.
  await svc
    .from('payments')
    .update({ peach_checkout_id: checkoutId })
    .eq('id', instalment1Id);

  // Stash the token in a cookie so the complete + done pages can read
  // it without depending on URL params alone. Cookie posture matches
  // the earlier Paystack flow — the widget's shopperResultUrl still
  // lands us on /checkout/{token}/complete.
  const cookieStore = await cookies();
  cookieStore.set('hnpl_checkout_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   60 * 60,
    path:     '/checkout',
  });

  // Fresh-checkout reuse signal — the ResumeCapture Pay that immediately
  // follows this redirect reuses THIS checkout (one createCheckout on the
  // normal path). See FRESH_CHECKOUT_COOKIE above.
  cookieStore.set(FRESH_CHECKOUT_COOKIE, checkoutId, {
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   FRESH_CHECKOUT_MAX_AGE_S,
    path:     '/checkout',
  });

  return { ok: true, checkoutId, amountCents, shopperResultUrl };
}

// ─── resumeFirstInstalmentCapture — re-open the widget for an owner ────────
//
// The routing rule shipped in 5b7f719 sent every logged-in owner to
// /patient/orders/{planId}/confirm. That page filters on status =
// 'pending_acceptance' — a plan that reached 'pending_first_payment'
// (i.e. initiateCheckout wrote its schedule) but never captured a card
// (peach_registration_id still NULL) fails that filter and bounces to
// /patient/orders, with no way to restart capture. Result observed
// 2026-07-30: new customer signed up mid-flow, widget failed to mount
// (mount-race, since fixed), account+plan persisted, patient stuck.
//
// This action re-opens the Peach V2 Checkout for the SAME plan +
// SAME instalment-1 row that initiateCheckout wrote on attempt 1.
// It is DELIBERATELY idempotent-for-resume:
//
//   • NO account creation. The auth user already exists (attempt 1
//     ran svc.auth.admin.createUser). We look them up via the session.
//   • NO profile upsert. Attempt 1 wrote the details; we read email +
//     first_name + last_name for the Peach `customer` block only.
//   • NO plan status/schedule rewrite. We do NOT touch plans.status,
//     plans.plan_type, plans.instalment_amount, or the payments table
//     (no delete-and-reinsert). Everything is a read.
//   • Deterministic Peach ref via checkoutRef(payment.id). Because the
//     payment.id is the same UUID initiateCheckout wrote on attempt 1
//     (we do NOT re-generate it), the merchantTransactionId is
//     BYTE-IDENTICAL across resume calls. Peach dedups on mtxid → a
//     mid-flight retry never opens a second real transaction.
//   • Only WRITE is stamping `peach_checkout_id` on the payment row
//     (idempotent — same UUID target). Cookie is refreshed so
//     /checkout/{token}/complete's cleanup path still reads it.
//
// Guards (in this order):
//   1. session user exists.
//   2. invitation row exists AND is unexpired AND unaccepted.
//   3. plan row exists AND plan.patient_id === session user id.
//      A non-owner never gets a checkout for a plan that isn't theirs.
//   4. plan.status === 'pending_first_payment' AND
//      plan.peach_registration_id IS NULL. This is the "uncaptured"
//      definition. A plan that already has a token is a saved-card
//      case and belongs on /confirm, not here.
//   5. payments[instalment_number=1] exists (initiateCheckout wrote
//      it on attempt 1; a missing row is a data-integrity bug).
//
// Returns the same shape as initiateCheckout's success branch so the
// client (ResumeCapture) can mount PeachWidget with no adaptation.

export type ResumeCaptureResult =
  | {
      ok:                 true;
      checkoutId:         string;
      amountCents:        number;
      shopperResultUrl:   string;
    }
  | { ok: false; error: string };

export async function resumeFirstInstalmentCapture(
  token: string,
  opts?: { reuseExisting?: boolean },
): Promise<ResumeCaptureResult> {
  if (!token) return { ok: false, error: 'Missing token.' };

  // reuseExisting is the caller's "reuse the freshly-minted checkout if
  // you safely can" hint (ResumeCapture always passes true). See the
  // mint-vs-reuse branch below — gated on the fresh-checkout cookie, it
  // lets the normal signup path make exactly ONE createCheckout call
  // instead of two-that-Peach-dedups, while a genuine re-entry mints.
  const reuseExisting = opts?.reuseExisting === true;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: 'You are not signed in — please open the emailed link again.' };
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // ── 1. Resolve the token — invitation OR POS session (mirrors
  // initiateCheckout's guard; see resolveCheckoutToken above) ──────
  const resolved = await resolveCheckoutToken(svc, token);
  if (!resolved) return { ok: false, error: 'This checkout link is no longer valid.' };

  // ── 2. Validate plan: owned by session user + uncaptured ─────────
  const { data: plan } = await svc
    .from('plans')
    .select('id, patient_id, status, peach_registration_id, plan_type, total_amount')
    .eq('id', resolved.planId)
    .maybeSingle();

  if (!plan) return { ok: false, error: 'This bill no longer exists.' };
  if ((plan.patient_id as string | null) !== user.id) {
    // A logged-in caller whose session doesn't own the plan should
    // never be handed a Peach checkout for that plan. The routing
    // rule in page.tsx already bounces this case; belt-and-braces
    // reject at the action boundary too.
    return { ok: false, error: 'This bill is not on your account.' };
  }
  if (plan.status !== 'pending_first_payment') {
    return {
      ok:    false,
      error: 'This bill isn\'t waiting for a first payment. Please open it from your orders.',
    };
  }
  if (plan.peach_registration_id) {
    return {
      ok:    false,
      error: 'This bill already has a stored card. Please continue from your orders.',
    };
  }

  // ── 3. Existing instalment-1 payment row (must exist post-attempt-1) ──
  const { data: payment } = await svc
    .from('payments')
    .select('id, amount, peach_checkout_id')
    .eq('plan_id', plan.id)
    .eq('instalment_number', 1)
    .maybeSingle();

  if (!payment) {
    // If we're here, initiateCheckout on attempt 1 wrote the plan
    // schedule (line 402) — a missing row is a data integrity bug,
    // not a normal state.
    return { ok: false, error: 'The first instalment record is missing. Please contact support.' };
  }

  // ── 4. Last instalment date for standingInstruction.expiry ───────
  const { data: lastInstalment } = await svc
    .from('payments')
    .select('due_date')
    .eq('plan_id', plan.id)
    .order('instalment_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  // ── 5. Profile for the Peach customer block ──────────────────────
  const { data: profile } = await svc
    .from('profiles')
    .select('email, first_name, last_name')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile?.email) return { ok: false, error: 'Account email not found.' };

  // ── 6. Deterministic Peach ref (same across resume calls) ────────
  //   Same instalment-1 id ⇒ same reference. Peach dedups on
  //   merchantTransactionId, so hammering resume never opens
  //   duplicate real transactions.
  const reference   = checkoutRef(payment.id as string);
  const amountCents = Math.round(Number(payment.amount) * 100);
  const appUrl      = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const shopperResultUrl = `${appUrl}/checkout/${token}/complete`;

  const lastDueDate = lastInstalment?.due_date as string | undefined;
  const expiryDate  = lastDueDate
    ? new Date(new Date(lastDueDate).getTime() + 30 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10)
    : '9999-12-31';
  const planType    = ((plan.plan_type as 2 | 3 | null) ?? 2) as 2 | 3;

  // ── 7. Reuse or mint the Peach V2 checkout ───────────────────────
  // Reuse the checkout initiateCheckout already minted + stamped on THIS
  // instalment-1 row ONLY when the fresh-checkout cookie confirms we're
  // in the same fresh journey (Continue-to-payment → this Pay, seconds
  // apart) AND its value matches the stamped id. That keeps the normal
  // flow at exactly ONE createCheckout.
  //
  // A genuine re-entry via the emailed link days later carries no fresh
  // cookie (it's expired), so we mint fresh — a checkout stamped in a
  // prior session is past its short validity window and reusing it would
  // dead-loop the widget on expiry. The deterministic merchantTransactionId
  // (built above from the same instalment-1 id) stays the safety net for
  // the mint path — a double-mint Peach-dedups to one real transaction.
  //
  // reuseExisting is the caller's "reuse if you safely can" hint
  // (ResumeCapture always passes true); the cookie is what makes it safe.
  const cookieStore        = await cookies();
  const freshCheckoutId    = cookieStore.get(FRESH_CHECKOUT_COOKIE)?.value ?? null;
  const existingCheckoutId = (payment.peach_checkout_id as string | null) ?? null;
  const canReuse =
    reuseExisting &&
    !!existingCheckoutId &&
    freshCheckoutId === existingCheckoutId;

  let checkoutId: string;
  if (canReuse) {
    checkoutId = existingCheckoutId as string;
  } else {
    const provider = getPaymentProvider();
    try {
      const checkout = await provider.createCheckout({
        amountCents,
        merchantTransactionId: reference,
        currency:              'ZAR',
        paymentType:           'DB',
        createRegistration:    true,
        shopperResultUrl,
        origin:                appUrl,
        // Card-only — same rationale as initiateCheckout. Wallet tokens
        // are single-use; instalments 2-N would be uncollectable.
        defaultPaymentMethod: 'CARD',
        forceDefaultMethod:   true,
        standingInstruction: {
          mode:                 'INITIAL',
          type:                 'INSTALLMENT',
          expiry:               expiryDate,
          frequency:            30,
          numberOfInstallments: planType,
        },
        customer: {
          email:     profile.email as string,
          givenName: (profile.first_name as string | null) ?? null,
          surname:   (profile.last_name  as string | null) ?? null,
        },
        customParameters: {
          SHOPPER_purpose:   'checkout_resume_first_payment',
          SHOPPER_token:     token,
          SHOPPER_patientId: user.id,
          SHOPPER_planId:    plan.id as string,
          SHOPPER_paymentId: payment.id as string,
        },
      });
      checkoutId = checkout.checkoutId;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Payment initialization failed.' };
    }

    // Idempotent stamp — same payment row on every call; the last
    // successful checkoutId wins. Peach dedups the mtxid so this is
    // never a race against a separate transaction. Skipped on the reuse
    // path: the id is already the one initiateCheckout stamped.
    await svc
      .from('payments')
      .update({ peach_checkout_id: checkoutId })
      .eq('id', payment.id as string);

    // Refresh the fresh-checkout cookie to the newly-minted id so a
    // re-tap of Pay in THIS session reuses it (no triple-mint) — while a
    // future re-entry still starts cold.
    cookieStore.set(FRESH_CHECKOUT_COOKIE, checkoutId, {
      httpOnly: true,
      sameSite: 'lax',
      secure:   process.env.NODE_ENV === 'production',
      maxAge:   FRESH_CHECKOUT_MAX_AGE_S,
      path:     '/checkout',
    });
  }

  // Match initiateCheckout's cookie posture so /checkout/[token]/complete
  // can read the token when the widget navigates back.
  cookieStore.set('hnpl_checkout_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   60 * 60,
    path:     '/checkout',
  });

  return { ok: true, checkoutId, amountCents, shopperResultUrl };
}

// ─── finalizePassword — set the patient's real password ────────────────────
//
// Called from /checkout/[token]/done after the patient picks a
// password. Replaces the temp password that initiateCheckout set,
// giving them real return-access credentials. After this they're
// redirected into the patient portal.

export type FinalizePasswordResult = { ok: true } | { ok: false; error: string };

export async function finalizePassword(password: string): Promise<FinalizePasswordResult> {
  if (typeof password !== 'string' || password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' };
  }
  if (password.length > 200) {
    return { ok: false, error: 'Password is too long.' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Session expired — please use the emailed link again.' };

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { ok: false, error: error.message };

  // Clear the checkout token cookie — the flow is done.
  // Match the path the cookie was set with (/checkout). Without an
  // explicit path here the delete writes a "phantom" cookie at /
  // and leaves the real /checkout-scoped one intact.
  const cookieStore = await cookies();
  cookieStore.delete({ name: 'hnpl_checkout_token', path: '/checkout' });

  return { ok: true };
}

// ─── Phone-verification server actions ──────────────────────────────────
//
// Two-call shape:
//
//   • requestPhoneOtp(token, phone) → server hashes a freshly-generated
//     6-digit code, asks the prepare RPC to store the hash + bump the
//     row, then sends the plaintext via SMSPortal. The plaintext code
//     never leaves this function locally; it's not returned to the
//     client, not stored at rest, not logged.
//   • verifyPhoneOtp(token, phone, code) → server hashes the entered
//     code, hands the hash to the verify RPC, returns the coded result.
//
// Both actions return a `{ ok: true } | { ok: false, code: ... }` shape
// where `code` is a stable string the client maps to a user-facing
// message. We resist embedding English in the action's return — the
// UI owns the copy.

export type PhoneOtpStartResult =
  | { ok: true }
  | { ok: false; code:
        | 'invalid_phone'        // normalisation failed
        | 'invalid_token'        // token doesn't match a live invitation
        | 'too_soon'             // <30s since last send
        | 'daily_limit'          // 5 sends in 24h cap hit for this (token, phone)
        | 'token_daily_limit'    // 10 sends in 24h cap hit for this token across all phones (SMS-burn guard, 0055)
        | 'sms_failed'           // SMSPortal returned non-2xx / timeout
        | 'sms_not_configured'   // creds missing (dev safety)
        // The aggregate fraud controls refused this send (audit S-07). A
        // separate code from the caps above because it is a different
        // judgement: those say "this token has had enough today", this says
        // "this number, or this device, or the platform's SMS bill, has".
        | 'risk_refused'
        | 'unknown';
    };

export async function requestPhoneOtp(
  token: string,
  phone: string,
): Promise<PhoneOtpStartResult> {
  if (!token) return { ok: false, code: 'invalid_token' };

  const normalizedPhone = normalizePhoneZA(phone);
  if (!normalizedPhone) return { ok: false, code: 'invalid_phone' };

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // ── Aggregate risk + the daily SMS budget (audit S-07) ────────────
  //
  // The anonymous twin of requestPhoneOtpForUser, and the one that matters
  // more: this path has no account behind it at all, so 0055's per-token
  // caps are the only limit and a fresh bill token buys a fresh allowance.
  // What this adds is the view across tokens — one number being verified
  // under several of them, one device walking a list, and the platform's
  // SMS bill for the day.
  //
  // Placed before the code is generated, so a refused send costs nothing
  // and writes nothing.
  const risk = await evaluateRisk({ event: 'phone_otp', phone: normalizedPhone });
  if (!mayProceed(risk)) return { ok: false, code: 'risk_refused' };

  // Generate + hash entirely server-side. The plaintext code is held
  // in a local variable for at most one fetch round-trip before it
  // goes to SMSPortal — never logged, never returned to the client.
  let code: string;
  let codeHash: string;
  try {
    code     = generateOtpCode();
    codeHash = hashOtpCode(code);
  } catch (err) {
    // hashOtpCode throws if PHONE_OTP_PEPPER is missing. We surface a
    // generic "couldn't send" to the client (no info disclosure) while
    // the operator sees the real error in logs.
    console.error('[checkout] requestPhoneOtp hash failure', err instanceof Error ? err.message : err);
    return { ok: false, code: 'unknown' };
  }

  const { data: prepResult, error: prepErr } = await svc.rpc('prepare_phone_verification', {
    p_token:     token,
    p_phone:     normalizedPhone,
    p_code_hash: codeHash,
  });
  if (prepErr) {
    console.warn('[checkout] prepare_phone_verification RPC error', prepErr.message);
    return { ok: false, code: 'unknown' };
  }
  const prepCode = prepResult as string;
  if (prepCode !== 'ok') {
    if (
      prepCode === 'too_soon' ||
      prepCode === 'daily_limit' ||
      prepCode === 'token_daily_limit' ||
      prepCode === 'invalid_token'
    ) {
      return { ok: false, code: prepCode };
    }
    return { ok: false, code: 'unknown' };
  }

  // RPC succeeded — the hash is now stored. Send the plaintext SMS.
  // sendSms is bounded (8s timeout + try/catch) so a slow / hanging
  // provider never hangs this action; the patient sees "couldn't
  // send" instead of a spinner that never returns.
  const smsResult = await sendSms(normalizedPhone, buildOtpSmsBody(code));
  if (!smsResult.ok) {
    if (smsResult.error === 'sms_not_configured') {
      return { ok: false, code: 'sms_not_configured' };
    }
    return { ok: false, code: 'sms_failed' };
  }
  return { ok: true };
}

export type PhoneOtpVerifyResult =
  | { ok: true }
  | { ok: false; code:
        | 'invalid_phone'
        | 'invalid_code_format'
        | 'wrong_code'
        | 'expired'
        | 'too_many_attempts'
        | 'not_found'
        | 'unknown';
    };

export async function verifyPhoneOtp(
  token: string,
  phone: string,
  enteredCode: string,
): Promise<PhoneOtpVerifyResult> {
  if (!token) return { ok: false, code: 'not_found' };

  const normalizedPhone = normalizePhoneZA(phone);
  if (!normalizedPhone) return { ok: false, code: 'invalid_phone' };

  const trimmed = (enteredCode ?? '').trim();
  // Cheap shape check before hashing — saves a wasted RPC call for an
  // obviously-malformed code (the user typed letters, pasted random
  // text). The RPC's hash compare would never match anyway.
  if (!/^\d{6}$/.test(trimmed)) return { ok: false, code: 'invalid_code_format' };

  let codeHash: string;
  try {
    codeHash = hashOtpCode(trimmed);
  } catch (err) {
    console.error('[checkout] verifyPhoneOtp hash failure', err instanceof Error ? err.message : err);
    return { ok: false, code: 'unknown' };
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data: result, error: rpcErr } = await svc.rpc('verify_phone_otp', {
    p_token:     token,
    p_phone:     normalizedPhone,
    p_code_hash: codeHash,
  });
  if (rpcErr) {
    console.warn('[checkout] verify_phone_otp RPC error', rpcErr.message);
    return { ok: false, code: 'unknown' };
  }
  const code = result as string;
  if (code === 'ok') return { ok: true };
  if (code === 'wrong_code' || code === 'expired' || code === 'too_many_attempts' || code === 'not_found') {
    return { ok: false, code };
  }
  return { ok: false, code: 'unknown' };
}
