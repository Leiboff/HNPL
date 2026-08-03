'use server';

import crypto from 'crypto';
import { cookies } from 'next/headers';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { getPaymentProvider } from '@/lib/payments/provider';
import { checkoutRef } from '@/lib/payments/peach/refs';
import { encryptId } from '@/lib/idEncryption';
import { splitInstalments, calculatePaymentDates } from '@/lib/finance';
import { TERMS_VERSION } from '@/lib/legal/terms';
import {
  isAllowedSalaryDay,
  ALLOWED_SALARY_DAYS,
} from '@/lib/salaryDates';
import {
  normalizePhoneZA,
  validateSaId,
  saIdAge,
  type SaIdInvalidReason,
} from '@/lib/validation';
import { findExistingAuthUser } from '@/lib/auth/findExistingAuthUser';
import { isPatientFrozen } from '@/lib/patient/freeze';
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

export type InitiateCheckoutInput = {
  token:       string;
  firstName:   string;
  lastName:    string;
  saIdNumber:  string;
  phone:       string;
  planType:    2 | 3;
  // Post-0065: salary day is a PROFILE-first source of truth. The
  // client sends this only when the patient has no salary_day on
  // their profile yet (new signup or legacy edge). If both the
  // profile and this field are unset, the server returns
  // `missing_salary_day` and the client shows an inline prompt.
  salaryDay?:  number | null;
};

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
  | { ok: false; error: string; frozen: true };

export async function initiateCheckout(input: InitiateCheckoutInput): Promise<InitiateCheckoutResult> {
  const { token, firstName, lastName, saIdNumber, phone, planType } = input;
  const clientSalaryDay: number | null =
    typeof input.salaryDay === 'number' ? input.salaryDay : null;

  if (!token)                  return { ok: false, error: 'Missing token.' };
  if (!firstName.trim())       return { ok: false, error: 'First name is required.' };
  if (!lastName.trim())        return { ok: false, error: 'Last name is required.' };

  const saIdResult = validateSaId(saIdNumber);
  if (!saIdResult.valid) return { ok: false, error: saIdErrorMessage(saIdResult.reason) };

  const age = saIdAge(saIdNumber);
  if (age === null || age < MIN_AGE) {
    return { ok: false, error: `You must be ${MIN_AGE} or older to accept a payment plan.` };
  }

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

  // ── 1. Validate the invitation (existence, expiry, not-accepted) ──────
  const { data: invitation } = await svc
    .from('patient_invitations')
    .select('id, email, plan_id, practice_id')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .is('accepted_at', null)
    .maybeSingle();

  if (!invitation) return { ok: false, error: 'This invitation link is no longer valid.' };

  const normalizedEmail = (invitation.email as string).trim().toLowerCase();

  // ── 2. Fetch the plan (need plan.patient_id BEFORE the user decision) ─
  // Why early: the discriminator below uses plan.patient_id to tell
  // "returning checkout patient" (reuse) apart from "organic-account
  // email collision" (reject with login guidance). The previous order
  // (auth lookup first, decide on email_confirmed_at alone) broke
  // decline-retry — see app/checkout/[token]/_lib/discriminate.ts.
  const { data: plan } = await svc
    .from('plans')
    .select('id, total_amount, status, application_id, practice_id, patient_id')
    .eq('id', invitation.plan_id)
    .maybeSingle();

  if (!plan) return { ok: false, error: 'This bill no longer exists.' };
  if (plan.status === 'completed' || plan.status === 'cancelled' || plan.status === 'declined') {
    return { ok: false, error: 'This bill has already been settled or cancelled.' };
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
  );

  if (decision.action === 'reject-organic-collision') {
    // #6 race / email collision with an organic BetterNow account.
    // The plan was bound to a different (or null) patient on the
    // new-patient fork; this confirmed user owns a separate organic
    // account. Send them to /login with a next= back to their bill's
    // acceptance page so the standard patient-portal path takes over
    // once they authenticate.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
    const next   = `/patient/orders/${plan.id}/confirm`;
    return {
      ok:           false,
      error:        'An account with this email already exists. Please log in to see this bill on your dashboard.',
      requireLogin: true,
      loginUrl:     `${appUrl}/login?next=${encodeURIComponent(next)}`,
    };
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
        invited_by_practice_id: invitation.practice_id,
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
  try {
    encryptedSaId = encryptId(saIdNumber.trim());
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
    salary_day:         salaryDay,
    // Phone-verification fact lands together with everything else this
    // action writes. Idempotent on retry — upsert re-applies the same
    // verified_at (or a refreshed one if the row was re-verified between
    // retries; we don't ratchet backward).
    phone_verified_at:  phoneVerifiedAt,
    // Checkout-origin patients never pass through signUpPatient, so this
    // is where their account-level T&C acceptance is recorded — the
    // checkout "I agree" tick, stamped server-side with the version.
    terms_accepted_at:  new Date().toISOString(),
    terms_version:      TERMS_VERSION,
  };

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

  // ── 5. Compute schedule + update plan with chosen terms ───────────────
  const totalAmount = Number(plan.total_amount);
  const instalments = splitInstalments(totalAmount, planType);
  const dates       = calculatePaymentDates(new Date(), salaryDay, planType);

  const { error: planTermsErr } = await svc
    .from('plans')
    .update({
      status:            'pending_first_payment',
      plan_type:         planType,
      instalment_amount: instalments[0],
      // Record acceptance of the payment-plan terms on the plan, at
      // activation — server-side, not just the client tick.
      terms_accepted_at: new Date().toISOString(),
      terms_version:     TERMS_VERSION,
    })
    .eq('id', plan.id);
  if (planTermsErr) return { ok: false, error: `Failed to set plan terms: ${planTermsErr.message}` };

  // ── 6. Create / refresh payments rows ─────────────────────────────────
  // Idempotent: if rows already exist (returning abandoner retrying),
  // wipe and re-create with a fresh schedule. Total instalment count
  // could have changed (2↔3) on the retry.
  await svc.from('payments').delete().eq('plan_id', plan.id);

  const instalment1Id = crypto.randomUUID();
  const paymentRows   = instalments.map((amount, i) => ({
    id:                i === 0 ? instalment1Id : crypto.randomUUID(),
    plan_id:           plan.id,
    patient_id:        userId,
    instalment_number: i + 1,
    amount,
    due_date:          dates[i].toISOString().split('T')[0],
    status:            i === 0 ? 'processing' : 'scheduled',
  }));

  const { error: paymentsErr } = await svc.from('payments').insert(paymentRows);
  if (paymentsErr) return { ok: false, error: `Failed to create schedule: ${paymentsErr.message}` };

  // ── 7. Stamp the Peach reference on the instalment-1 row ─────────────
  // Compact 16-char ref per Peach V2 mandate. Deterministic per
  // instalment-1 payment id so a mid-flight retry Peach-dedups.
  // Webhook echoes it back as merchantTransactionId; reconcile via
  // payments.peach_payment_id.
  const reference = checkoutRef(instalment1Id);
  await svc.from('payments').update({ peach_payment_id: reference }).eq('id', instalment1Id);

  // ── 8. Sign the user in via fresh temp password ───────────────────────
  // We need an authenticated session before redirecting to Peach so
  // the callback returns into the right cookie context. updateUserById
  // sets a known password; signInWithPassword establishes the session.
  const sessionTempPwd = generateTempPassword();
  const { error: pwdErr } = await svc.auth.admin.updateUserById(userId, {
    password: sessionTempPwd,
  });
  if (pwdErr) return { ok: false, error: `Failed to establish session: ${pwdErr.message}` };

  const supabaseAuth = await createClient();
  const { error: signInErr } = await supabaseAuth.auth.signInWithPassword({
    email:    normalizedEmail,
    password: sessionTempPwd,
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
  const lastInstalmentDate = dates[dates.length - 1];
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

  // ── 1. Validate the invitation (mirrors initiateCheckout guard) ──
  const { data: invitation } = await svc
    .from('patient_invitations')
    .select('id, email, plan_id, practice_id')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .is('accepted_at', null)
    .maybeSingle();

  if (!invitation) return { ok: false, error: 'This invitation link is no longer valid.' };

  // ── 2. Validate plan: owned by session user + uncaptured ─────────
  const { data: plan } = await svc
    .from('plans')
    .select('id, patient_id, status, peach_registration_id, plan_type, total_amount')
    .eq('id', invitation.plan_id)
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
