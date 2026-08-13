'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { isPatientFrozen } from '@/lib/patient/freeze';
import { declineCheckoutSessionsForPlan } from '@/lib/checkout/declineCheckoutSessions';
import { splitInstalments, calculatePaymentDates } from '@/lib/finance';
import { getPaymentProvider } from '@/lib/payments/provider';
import { checkoutRef, registrationRef } from '@/lib/payments/peach/refs';
import { isCardValidForPlan } from '@/lib/cardValidity';
import { computeOnboarding, type ProfileForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import { TERMS_VERSION } from '@/lib/legal/terms';
import { PRIVACY_VERSION } from '@/lib/legal/privacy';
import type { User } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Onboarding gate for acceptance actions ────────────────────────────
//
// A patient cannot accept a bill / initiate checkout until their
// onboarding is complete. Enforced SERVER-SIDE here (as well as by
// the routing gate in app/patient/layout.tsx) so that a UI regression
// or direct action call from a client can never bypass onboarding.
//
// Returns null when the patient is onboarded (or the flag columns
// aren't in the schema yet — fail-open during migration deploys).
// Returns an ActionError with a link to /onboarding when they're not.

type OnboardingRefusal = {
  error:  string;
  reason: 'not_onboarded';
  href:   string;
};

async function requireOnboarded(
  supabase: SupabaseClient,
  user:     User,
): Promise<OnboardingRefusal | null> {
  const { data: profile } = await supabase
    .from('profiles')
    .select(
      'phone_verified_at, sa_id_number, salary_day, credit_check_status, ' +
      'liveness_verified_at, onboarding_completed',
    )
    .eq('id', user.id)
    .maybeSingle();

  // Missing profile is handled by the caller's own "plan not found"
  // paths — treat as onboarded=false to be safe.
  if (!profile) {
    return {
      error:  'Please finish setting up your account before accepting a bill.',
      reason: 'not_onboarded',
      href:   '/onboarding',
    };
  }

  const status = computeOnboarding(
    {
      email_confirmed_at: user.email_confirmed_at ?? null,
      identity_providers: (user.identities ?? []).map((i) => i.provider),
    },
    profile as unknown as ProfileForOnboarding,
    currentFlags(),
  );
  if (status.done) return null;

  return {
    error:  'Please finish setting up your account before accepting a bill.',
    reason: 'not_onboarded',
    href:   '/onboarding',
  };
}

async function isBlockedFromNewPlan(patientId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data: rows } = await supabase
    .from('plans')
    .select('status')
    .eq('patient_id', patientId)
    .in('status', ['pending_first_payment', 'active', 'completed']);

  if (!rows || rows.length === 0) return false;
  const hasInProgress = rows.some(
    (r) => r.status === 'pending_first_payment' || r.status === 'active',
  );
  const hasCompleted = rows.some((r) => r.status === 'completed');
  return hasInProgress && !hasCompleted;
}

export async function acceptPlan(
  planId: string,
  planType: 2 | 3,
): Promise<{ error: string | null; reason?: 'not_onboarded'; frozen?: boolean; href?: string }> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  // ─── Onboarding gate ─────────────────────────────────────────────
  const refusal = await requireOnboarded(supabase, user);
  if (refusal) return refusal;

  if (planType !== 2 && planType !== 3) {
    return { error: 'Invalid instalment count. Choose 2 or 3.' };
  }

  const { data: plan } = await supabase
    .from('plans')
    .select('id, total_amount, practice_id, application_id')
    .eq('id', planId)
    .eq('patient_id', user.id)
    .eq('status', 'pending_acceptance')
    .maybeSingle();

  if (!plan) return { error: 'Plan not found or already actioned.' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('salary_day')
    .eq('id', user.id)
    .single();

  const salaryDay = profile?.salary_day as number | null;
  if (!salaryDay) return { error: 'Please set your salary date before accepting.' };

  // ─── Default freeze gate ─────────────────────────────────────────
  // Checked BEFORE the one-plan velocity rule below: the freeze is the
  // more specific block (unresolved default) and carries its own message.
  // It also catches repeat customers who have completed a plan before —
  // they're exempt from isBlockedFromNewPlan, but a default still freezes
  // them out until settled.
  if (await isPatientFrozen(supabase, user.id)) {
    return {
      error: "You have a defaulted plan. You can't take on a new plan until it's settled — settle it from your orders first.",
      frozen: true,
    };
  }

  if (await isBlockedFromNewPlan(user.id)) {
    return { error: 'Please complete your current payment plan before starting another.' };
  }

  const totalAmount = Number(plan.total_amount);
  const instalments = splitInstalments(totalAmount, planType);
  const dates       = calculatePaymentDates(new Date(), salaryDay, planType);

  const { error: planError } = await supabase
    .from('plans')
    .update({
      status:            'pending_first_payment',
      plan_type:         planType,
      instalment_amount: instalments[0],
      // Record acceptance of the payment-plan terms + privacy policy on
      // the plan, at activation — server-side, not just the client tick.
      terms_accepted_at: new Date().toISOString(),
      terms_version:     TERMS_VERSION,
      privacy_version:   PRIVACY_VERSION,
    })
    .eq('id', planId)
    .eq('patient_id', user.id);

  if (planError) return { error: planError.message };

  const paymentRows = instalments.map((amount, i) => ({
    id:                crypto.randomUUID(),
    plan_id:           planId,
    patient_id:        user.id,
    instalment_number: i + 1,
    amount,
    due_date:          dates[i].toISOString().split('T')[0],
    status:            i === 0 ? 'processing' : 'scheduled',
  }));

  const { error: paymentsError } = await supabase.from('payments').insert(paymentRows);
  if (paymentsError) return { error: paymentsError.message };

  if (plan.application_id) {
    await supabase
      .from('applications')
      .update({ plan_type: planType })
      .eq('id', plan.application_id as string);
  }

  revalidatePath('/patient', 'layout');
  return { error: null };
}

export async function initializeFirstPayment(
  planId: string,
): Promise<{ error: string | null; checkoutId?: string; shopperResultUrl?: string; amountCents?: number }> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const { data: plan } = await supabase
    .from('plans')
    .select('id, status, plan_type')
    .eq('id', planId)
    .eq('patient_id', user.id)
    .eq('status', 'pending_first_payment')
    .maybeSingle();

  if (!plan) return { error: 'Plan not found or not ready for payment.' };

  const { data: payment } = await supabase
    .from('payments')
    .select('id, amount')
    .eq('plan_id', planId)
    .eq('patient_id', user.id)
    .eq('instalment_number', 1)
    .maybeSingle();

  if (!payment) return { error: 'First instalment not found.' };

  // Last instalment's due_date drives standingInstruction.expiry.
  const { data: lastInstalment } = await supabase
    .from('payments')
    .select('due_date')
    .eq('plan_id', planId)
    .eq('kind', 'instalment')
    .order('instalment_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: profile } = await supabase
    .from('profiles')
    .select('email, first_name, last_name')
    .eq('id', user.id)
    .single();

  if (!profile?.email) return { error: 'Account email not found.' };

  // Compact 16-char peach ref. Deterministic per instalment-1 id so
  // retries Peach-dedup.
  const reference   = checkoutRef(payment.id);
  const amountCents = Math.round(Number(payment.amount) * 100);
  const appUrl      = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const shopperResultUrl = `${appUrl}/patient/payment-complete`;

  // Flow A standingInstruction fields — see checkout/actions.ts for
  // the design comment. Same rationale here.
  const lastDueDate = lastInstalment?.due_date as string | undefined;
  const expiryDate = lastDueDate
    ? new Date(new Date(lastDueDate).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : '9999-12-31'; // Mastercard scheme default when unknown
  // planType is set on the plan when acceptPlan / checkout initiate
  // wrote 'pending_first_payment'. If null (legacy row) default to 2 —
  // any value 1-999 is accepted by the V2 schema.
  const planType = ((plan.plan_type as 2 | 3 | null) ?? 2) as 2 | 3;

  const provider = getPaymentProvider();
  let checkoutId: string;
  try {
    const checkout = await provider.createCheckout({
      amountCents,
      merchantTransactionId: reference,
      currency:              'ZAR',
      paymentType:           'DB',
      createRegistration:    true,
      shopperResultUrl,
      origin:                appUrl,
      // Peach V2 SI — INITIAL + INSTALLMENT, first CIT capture via the
      // embedded widget. V2 does NOT accept `source` (OPPWA-only).
      // See app/checkout/[token]/actions.ts for the full comment.
      standingInstruction: {
        mode:                 'INITIAL',
        type:                 'INSTALLMENT',
        expiry:               expiryDate,
        frequency:            30,        // days between authorisations
        numberOfInstallments: planType,  // 2 or 3, both valid (1-999)
      },
      customer: {
        email:     profile.email,
        givenName: profile.first_name ?? null,
        surname:   profile.last_name  ?? null,
      },
      customParameters: {
        SHOPPER_planId:    planId,
        SHOPPER_paymentId: payment.id,
      },
    });
    checkoutId = checkout.checkoutId;
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to initialize payment.' };
  }

  const { error: updateError } = await supabase
    .from('payments')
    .update({ peach_payment_id: reference, peach_checkout_id: checkoutId })
    .eq('id', payment.id)
    .eq('patient_id', user.id);

  if (updateError) return { error: updateError.message };

  return { error: null, checkoutId, shopperResultUrl, amountCents };
}

export async function initializeCardRegistration(returnTo?: string): Promise<{
  error:            string | null;
  checkoutId?:      string;
  shopperResultUrl?: string;
}> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('email, first_name, last_name')
    .eq('id', user.id)
    .single();

  if (!profile?.email) return { error: 'Account email not found.' };

  // Compact 16-char peach ref. Random per-attempt (no natural
  // deterministic seed — patient can add many cards on the same
  // account, and each attempt should get a fresh unique ref).
  const reference = registrationRef(crypto.randomUUID());
  const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  const safePath = (returnTo && returnTo.startsWith('/'))
    ? returnTo
    : '/patient/payment-methods/complete';
  const shopperResultUrl = `${appUrl}${safePath}`;

  // Flow B — card-vault ONLY. Runs on the SAME Checkout V2 door as
  // Flow A via the zero-amount PA registration recipe (amount 0 +
  // paymentType 'PA' + createRegistration + card-only). No money moves
  // — the zero-value PA auto-expires — and the embedded widget renders
  // the same card-only form as Flow A. The completion route reads the
  // result via getCheckoutStatus (shopperResultUrl?checkoutId={id}).
  //
  // The registrationId this produces has NO initial CIT transaction —
  // plans that use this card later will send their first MIT under
  // standingInstruction.type=UNSCHEDULED (chain-root fallback
  // implemented in chargeInstalment.ts + settle-actions.ts).
  const provider = getPaymentProvider();
  try {
    const registration = await provider.createCardRegistration({
      merchantTransactionId: reference,
      shopperResultUrl,
      origin: appUrl,
      customer: {
        email:     profile.email,
        givenName: profile.first_name ?? null,
        surname:   profile.last_name  ?? null,
      },
      customParameters: {
        SHOPPER_purpose:   'card_registration',
        SHOPPER_patientId: user.id,
      },
    });
    return { error: null, checkoutId: registration.checkoutId, shopperResultUrl };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to initialize card registration.' };
  }
}

export async function payWithSavedCard(
  planId:          string,
  planType:        2 | 3,
  paymentMethodId: string,
): Promise<{
  error:             string | null;
  planId?:           string;
  reason?:           'not_onboarded';
  frozen?:           boolean;
  href?:             string;
  // The saved-card first instalment is a CUSTOMER-PRESENT (CIT) charge:
  // it runs through a Checkout V2 one-click widget (3DS-eligible, roots
  // the stored-credential chain), NOT a silent server-to-server MIT.
  // On success the caller mounts the embedded widget against checkoutId.
  checkoutId?:       string;
  shopperResultUrl?: string;
  amountCents?:      number;
}> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  // ─── Onboarding gate ─────────────────────────────────────────────
  const refusal = await requireOnboarded(supabase, user);
  if (refusal) return refusal;

  // ─── Default freeze gate ─────────────────────────────────────────
  // The saved-card one-click is the returning-patient equivalent of
  // accepting a bill. If the patient has an unresolved defaulted plan,
  // block it server-side (same gate as the cold-checkout initiateCheckout
  // path) — they must settle the default before starting anything new,
  // whether a fresh acceptance or a resume of an abandoned one.
  if (await isPatientFrozen(supabase, user.id)) {
    return {
      error: "You have a defaulted plan. You can't take on a new plan until it's settled — settle it from your orders first.",
      frozen: true,
    };
  }

  if (planType !== 2 && planType !== 3) {
    return { error: 'Invalid instalment count. Choose 2 or 3.' };
  }

  // Load the plan. Two valid entry states:
  //   • pending_acceptance — a FRESH acceptance (create schedule + charge).
  //   • pending_first_payment WITHOUT a stored registration — a RESUME of
  //     an abandoned first-charge one-click (reuse the existing schedule +
  //     deterministic ref; no new rows, no plan-status change, no double
  //     charge). A plan that already has a peach_registration_id has
  //     captured its card and is NOT resumable here.
  // provider_member_id is loaded up-front so activateFirstInstalment can
  // resolve the treating practitioner for the payout row. It does NOT affect
  // where the money goes — payout_destination has been the literal 'practice'
  // since the payout runner landed, and the per-provider destination this
  // comment used to describe was removed with it.
  const { data: plan } = await supabase
    .from('plans')
    .select('id, total_amount, practice_id, application_id, provider_member_id, status, plan_type, peach_registration_id')
    .eq('id', planId)
    .eq('patient_id', user.id)
    .in('status', ['pending_acceptance', 'pending_first_payment'])
    .maybeSingle();

  if (!plan) return { error: 'Plan not found or already actioned.' };

  const isResume = plan.status === 'pending_first_payment';
  if (isResume && plan.peach_registration_id) {
    // Already has a stored card — the first charge landed (or is in
    // flight). Not resumable here; the orders view reflects its state.
    return { error: 'This bill is already being paid. Please check your orders.' };
  }

  // On resume the plan already fixed its instalment count when it was
  // first accepted; honour it so a changed selection can't diverge from
  // the existing schedule/ref (Peach would dedup back to the original
  // amount anyway). A fresh acceptance uses the caller's choice.
  const effectivePlanType = (isResume ? ((plan.plan_type as 2 | 3 | null) ?? planType) : planType) as 2 | 3;
  if (effectivePlanType !== 2 && effectivePlanType !== 3) {
    return { error: 'Invalid instalment count. Choose 2 or 3.' };
  }

  // Fetch profile (salary day + email + name for the Peach customer block)
  const { data: profile } = await supabase
    .from('profiles')
    .select('salary_day, email, first_name, last_name')
    .eq('id', user.id)
    .single();

  const salaryDay = profile?.salary_day as number | null;
  if (!salaryDay) return { error: 'Please set your salary date before accepting.' };

  if (!profile?.email) return { error: 'Account email not found.' };

  // Verify payment method is reusable and belongs to this patient
  const { data: paymentMethod } = await supabase
    .from('payment_methods')
    .select('id, token, expiry_month, expiry_year, last_four, card_brand, reusable')
    .eq('id', paymentMethodId)
    .eq('patient_id', user.id)
    .eq('reusable', true)
    .maybeSingle();

  if (!paymentMethod) return { error: 'Card not found or not usable.' };

  // Block only a FRESH new plan — a resume IS the in-progress plan, so it
  // must not be blocked by its own in-progress status.
  if (!isResume && await isBlockedFromNewPlan(user.id)) {
    return { error: 'Please complete your current payment plan before starting another.' };
  }

  // Calculate instalment schedule
  const totalAmount  = Number(plan.total_amount);
  const instalments  = splitInstalments(totalAmount, effectivePlanType);
  const dates        = calculatePaymentDates(new Date(), salaryDay, effectivePlanType);

  // Validate the card covers the full plan (expiry + 30-day buffer after last instalment)
  const lastInstalmentDate = dates[dates.length - 1];
  if (!isCardValidForPlan(
    { exp_month: paymentMethod.expiry_month, exp_year: paymentMethod.expiry_year },
    lastInstalmentDate,
    30,
  )) {
    const deadlineMs  = lastInstalmentDate.getTime() + 30 * 24 * 60 * 60 * 1000;
    const deadlineStr = new Date(deadlineMs).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
    return { error: `This card expires before your final payment. Please add a card valid until at least ${deadlineStr}.` };
  }

  // ─── DB-WRITE + CHECKOUT-INITIATE REGION (try/catch around it) ────
  //
  // Everything below this line writes state that leaves the plan in
  // an incomplete/processing status if it isn't followed through with
  // a completed checkout. Prior to the 2026-07-21 fix there was NO
  // safety net here — any unhandled throw between the payment INSERT
  // and the provider call left the plan on pending_first_payment with a
  // payment row perpetually stuck at status='processing' (visible in
  // OrdersView as "Charging — was due …"). The PEACH PAY-WITH-SAVED-CARD
  // log below never appeared in Vercel logs because execution died
  // before it — either an unexpected throw or a function-timeout kill.
  //
  // The try/catch is a hard safety net. On ANY throw here we:
  //   1. Delete the freshly-inserted payment rows so the plan has no
  //      orphan 'processing' payment for the OrdersView badge.
  //   2. Reset the plan back to 'pending_acceptance' so the patient
  //      can retry from the confirm page (which requires that state).
  //   3. Return a user-visible error to the client.
  // No more silent processing-limbo state.
  //
  // We also log STEP tags at every hop so if this ever stalls again
  // the exact line is unambiguous in Vercel logs.

  console.log('PEACH PAY-WITH-SAVED-CARD STEP 0 ENTER:', {
    planId,
    paymentMethodId,
    isResume,
    hasToken: !!paymentMethod.token,
  });

  // For a RESUME, reuse the EXISTING instalment-1 row id so the
  // deterministic Peach ref is byte-identical to the abandoned attempt
  // (Peach dedups on merchantTransactionId → no double charge). For a
  // FRESH acceptance, mint a new id.
  let instalment1Id: string;
  if (isResume) {
    const { data: existing } = await supabase
      .from('payments')
      .select('id')
      .eq('plan_id', planId)
      .eq('patient_id', user.id)
      .eq('instalment_number', 1)
      .maybeSingle();
    if (!existing) {
      return { error: 'The first instalment record is missing. Please contact support.' };
    }
    instalment1Id = existing.id as string;
  } else {
    instalment1Id = crypto.randomUUID();
  }

  // Rollback helper — used from every catch in this region. Best-
  // effort: if a rollback DB call ALSO fails, log + swallow so the
  // caller still sees the original error.
  async function rollbackPlanState(reason: string): Promise<void> {
    // NEVER roll back a RESUME: the plan + schedule are a legitimate
    // in-progress state from the original acceptance, and the CIT is
    // idempotent (deterministic ref). Deleting rows / resetting to
    // pending_acceptance would destroy a valid plan on a transient error.
    // A fresh acceptance, by contrast, unwinds cleanly to retry.
    if (isResume) {
      console.warn('PEACH PAY-WITH-SAVED-CARD ROLLBACK SKIPPED (resume):', { planId, reason });
      return;
    }
    console.error('PEACH PAY-WITH-SAVED-CARD ROLLBACK:', { planId, reason });
    try {
      await supabase.from('payments').delete().eq('plan_id', planId);
      await supabase.from('plans')
        .update({ status: 'pending_acceptance', plan_type: null, instalment_amount: null })
        .eq('id', planId);
    } catch (rbErr) {
      console.error('PEACH PAY-WITH-SAVED-CARD ROLLBACK FAILED:', {
        planId,
        reason,
        error: rbErr instanceof Error ? rbErr.message : String(rbErr),
      });
    }
  }

  try {
    // Compact 16-char peach ref, seeded off the instalment-1 id — Peach
    // dedups on merchantTransactionId, so it's byte-identical across a
    // fresh attempt and every resume, and a retry never double-charges.
    const reference = checkoutRef(instalment1Id);

    if (!isResume) {
      // ── STEP 1: move plan → pending_first_payment ──────────────────
      console.log('PEACH PAY-WITH-SAVED-CARD STEP 1 PLAN UPDATE:', { planId });
      const { error: planError } = await supabase
        .from('plans')
        .update({
          status:            'pending_first_payment',
          plan_type:         effectivePlanType,
          instalment_amount: instalments[0],
          // Record acceptance of the payment-plan terms + privacy policy
          // on the plan, at activation — server-side, not just the tick.
          terms_accepted_at: new Date().toISOString(),
          terms_version:     TERMS_VERSION,
          privacy_version:   PRIVACY_VERSION,
        })
        .eq('id', planId)
        .eq('patient_id', user.id);

      if (planError) return { error: planError.message };

      // ── STEP 2: insert payment rows (instalment 1 = 'processing') ──
      const paymentRows = instalments.map((amount, i) => ({
        id:                i === 0 ? instalment1Id : crypto.randomUUID(),
        plan_id:           planId,
        patient_id:        user.id,
        instalment_number: i + 1,
        amount,
        due_date:          dates[i].toISOString().split('T')[0],
        status:            i === 0 ? 'processing' : 'scheduled',
      }));

      console.log('PEACH PAY-WITH-SAVED-CARD STEP 2 PAYMENTS INSERT:', {
        planId,
        rowCount: paymentRows.length,
        instalment1Id,
      });
      const { error: paymentsError } = await supabase.from('payments').insert(paymentRows);
      if (paymentsError) {
        await rollbackPlanState(`paymentsError: ${paymentsError.message}`);
        return { error: paymentsError.message };
      }

      if (plan.application_id) {
        await supabase
          .from('applications')
          .update({ plan_type: effectivePlanType })
          .eq('id', plan.application_id as string);
      }

      // ── STEP 3: stamp merchant reference on the payment row ─────────
      console.log('PEACH PAY-WITH-SAVED-CARD STEP 3 REF STAMP:', {
        planId,
        instalment1Id,
        merchantTransactionId: reference,
      });
      const { error: refErr } = await supabase
        .from('payments')
        .update({ peach_payment_id: reference })
        .eq('id', instalment1Id)
        .eq('patient_id', user.id);
      if (refErr) {
        await rollbackPlanState(`refErr: ${refErr.message}`);
        return { error: refErr.message };
      }
    } else {
      // ── RESUME: plan + schedule already exist (an abandoned first
      // charge). Re-stamp the SAME deterministic ref idempotently; no
      // plan-status change, no new rows. The plan stays
      // pending_first_payment and the CIT re-opens for the same amount.
      console.log('PEACH PAY-WITH-SAVED-CARD RESUME REF STAMP:', {
        planId,
        instalment1Id,
        merchantTransactionId: reference,
      });
      await supabase
        .from('payments')
        .update({ peach_payment_id: reference })
        .eq('id', instalment1Id)
        .eq('patient_id', user.id);
    }

    // ── STEP 4: customer-present CIT via Checkout V2 one-click ───────
    //
    // The cardholder is PRESENT (they just tapped "Confirm and pay"), so
    // this first instalment is a CIT — a 3DS-eligible, liability-shifted
    // charge that BECOMES the stored-credential chain root. A CIT on a
    // stored card can only run through Checkout V2 (the recurring /v1 API
    // is MIT / server-to-server, so 3DS is impossible there). We pass the
    // saved token via cardTokens for a mostly-frictionless one-click: the
    // widget re-presents the KNOWN card, not a re-enter-card form.
    //
    // This REPLACES the previous silent MIT UNSCHEDULED charge, which was
    // customer-present but tagged merchant-initiated — no 3DS, no
    // liability shift, and no chain root (so instalments 2-N fell back to
    // UNSCHEDULED forever). The embedded widget completes on
    // /patient/payment-complete, which stamps peach_registration_id +
    // peach_initial_transaction_id (the CIT root) and activates
    // instalment 1 via activateFirstInstalment. Instalments 2-N then
    // charge rooted MIT INSTALLMENT (chargeInstalment.ts).
    const amountCents = Math.round(instalments[0] * 100);
    const appUrl      = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const shopperResultUrl = `${appUrl}/patient/payment-complete`;

    console.log('PEACH PAY-WITH-SAVED-CARD REQUEST:', {
      planId,
      paymentMethodId,
      registrationId: paymentMethod.token,
      hasToken:       !!paymentMethod.token,
      amountCents,
      merchantTransactionId: reference,
      surface:        'checkout-v2-one-click-cit',
    });

    // Empty token guard — without a stored token there's nothing to
    // one-click. Short-circuit with a human-readable message instead of
    // handing Peach an empty cardTokens array.
    if (!paymentMethod.token) {
      await rollbackPlanState('paymentMethod.token is null/empty');
      return { error: 'This card is missing its payment token. Please remove it and add it again.' };
    }

    // Last instalment date (computed above) drives standingInstruction.
    // expiry (covers late-collection retries within the dunning ladder).
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
        createRegistration:    true,   // return/refresh the reusable token
        // One-click on the SAVED card → CIT with 3DS, roots the chain.
        // cardTokens alone is the documented one-click enabler; we send
        // no extra "show stored cards" flag (V2 rejects it as an unknown
        // field — proven live 2026-08-02, see client.createCheckout).
        cardTokens:            [paymentMethod.token as string],
        // Card-only — same rationale as Flow A (wallet tokens are
        // single-use; instalments 2-N would be uncollectable).
        defaultPaymentMethod:  'CARD',
        forceDefaultMethod:    true,
        shopperResultUrl,
        origin:                appUrl,
        // Same V2 SI as Flow A: INITIAL + INSTALLMENT, first CIT capture.
        // V2 does NOT accept `source` (OPPWA-only).
        standingInstruction: {
          mode:                 'INITIAL',
          type:                 'INSTALLMENT',
          expiry:               expiryDate,
          frequency:            30,
          numberOfInstallments: effectivePlanType,
        },
        customer: {
          email:     profile.email,
          givenName: (profile as { first_name?: string | null }).first_name ?? null,
          surname:   (profile as { last_name?:  string | null }).last_name  ?? null,
        },
        customParameters: {
          SHOPPER_purpose:   'saved_card_first_payment',
          SHOPPER_planId:    planId,
          SHOPPER_paymentId: instalment1Id,
          SHOPPER_patientId: user.id,
        },
      });
      checkoutId = checkout.checkoutId;
    } catch (err) {
      // Initiate failed before any charge — roll the plan/payments back
      // to pending_acceptance so the patient can retry from /confirm.
      await rollbackPlanState(`createCheckout: ${err instanceof Error ? err.message : String(err)}`);
      return { error: err instanceof Error ? err.message : 'Could not start the payment. Please try again.' };
    }

    // Stamp the checkout id for reconciliation / admin lookups.
    await supabase
      .from('payments')
      .update({ peach_checkout_id: checkoutId })
      .eq('id', instalment1Id)
      .eq('patient_id', user.id);

    console.log('PEACH PAY-WITH-SAVED-CARD RESPONSE:', {
      planId,
      checkoutId,
      surface: 'checkout-v2-one-click-cit',
    });

    // Activation happens on the return route (/patient/payment-complete)
    // AFTER the widget completes + 3DS resolves — NOT here. The plan sits
    // at pending_first_payment until then (parity with Flow A). The
    // deterministic ref keeps a retry idempotent (Peach dedups on
    // merchantTransactionId → no double charge).
    console.log('PEACH PAY-WITH-SAVED-CARD STEP 4 HANDOFF:', { planId, checkoutId });
    revalidatePath('/patient', 'layout');
    return { error: null, planId, checkoutId, shopperResultUrl, amountCents };
  } catch (err) {
    // The load-bearing safety net. Anything that throws in the
    // DB-write region above lands here; the plan/payments get rolled
    // back and the user sees an actionable error instead of a
    // permanent "Charging…" limbo.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('PEACH PAY-WITH-SAVED-CARD UNCAUGHT:', { planId, error: msg });
    await rollbackPlanState(`uncaught: ${msg}`);
    return { error: `Payment could not be started (${msg}). Please try again.` };
  }
}

export async function declinePlan(
  planId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const { data: plan } = await supabase
    .from('plans')
    .select('id')
    .eq('id', planId)
    .eq('patient_id', user.id)
    .eq('status', 'pending_acceptance')
    .maybeSingle();

  if (!plan) return { error: 'Plan not found or already actioned.' };

  const { error: planError } = await supabase
    .from('plans')
    .update({ status: 'declined' })
    .eq('id', planId)
    .eq('patient_id', user.id);

  if (planError) return { error: planError.message };

  // ── Propagate to the POS counter session, if this bill had one ────────
  // A till-issued bill carries a checkout_sessions row (migration 0085)
  // whose stage is what the till's "Today at this till" strip reports.
  // Without this the plan reads 'declined' while its session sits at
  // created/scanned, so the front desk is told "Waiting on patient" about a
  // bill the patient refused — and it never corrects itself, because
  // expire_stale_checkout_session only acts while the plan is still
  // pending (see lib/checkout/declineCheckoutSessions.ts).
  //
  // Deliberately not returned to the patient as an error. Their decline HAS
  // happened and is not retryable — the read above is scoped to
  // status='pending_acceptance', so a second attempt gets "already
  // actioned". Failing the action here would report a failure for something
  // that succeeded and leave them with no way forward. Logged instead, at
  // the same severity as the completion route's own session-stage write.
  const sessionPropagation = await declineCheckoutSessionsForPlan(planId);
  if (sessionPropagation.error) {
    console.error('DECLINE PLAN: checkout_sessions propagation failed', {
      planId,
      error: sessionPropagation.error,
      note: 'plan IS declined; the till strip may still show this session as waiting',
    });
  }

  revalidatePath('/patient', 'layout');
  return { error: null };
}
