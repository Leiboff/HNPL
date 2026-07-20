'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { splitInstalments, calculatePaymentDates } from '@/lib/finance';
import { getPaymentProvider } from '@/lib/payments/provider';
import { checkoutRef, registrationRef } from '@/lib/payments/peach/refs';
import { isCardValidForPlan } from '@/lib/cardValidity';
import { computeOnboarding, type ProfileForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
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
): Promise<{ error: string | null; reason?: 'not_onboarded'; href?: string }> {
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
  const planType = plan.plan_type as 2 | 3 | null;
  const numberOfInstallments = planType === 3 ? 3 : undefined;

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
      // INITIAL / INSTALLMENT / CIT — fixed-instalment plan, first CIT
      // capture. The V2 embedded widget handles 3DS in-page.
      standingInstruction: {
        mode:      'INITIAL',
        source:    'CIT',
        type:      'INSTALLMENT',
        expiry:    expiryDate,
        frequency: '0001',
        ...(numberOfInstallments !== undefined ? { numberOfInstallments } : {}),
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

  // Flow B — card-vault ONLY. Runs on the COPYandPAY "second door"
  // (see lib/payments/peach/copyandpay/registration.ts). No debit,
  // no PA hold, no shopper billing fields — the widget renders a
  // minimal card form with a "Save card"-style button. Runs on the
  // recurring credential family (same creds as Flow C MIT charges),
  // NOT on Checkout V2 OAuth.
  //
  // The registrationId this produces has NO initial transaction —
  // plans that use this card later will send their first MIT under
  // standingInstruction.type=UNSCHEDULED (chain-root fallback
  // implemented in chargeInstalment.ts + settle-actions.ts).
  const provider = getPaymentProvider();
  try {
    const registration = await provider.createCardRegistration({
      merchantTransactionId: reference,
      shopperResultUrl,
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
): Promise<{ error: string | null; planId?: string; reason?: 'not_onboarded'; href?: string }> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  // ─── Onboarding gate ─────────────────────────────────────────────
  const refusal = await requireOnboarded(supabase, user);
  if (refusal) return refusal;

  if (planType !== 2 && planType !== 3) {
    return { error: 'Invalid instalment count. Choose 2 or 3.' };
  }

  // Verify plan belongs to this patient and is awaiting acceptance
  const { data: plan } = await supabase
    .from('plans')
    .select('id, total_amount, practice_id, application_id')
    .eq('id', planId)
    .eq('patient_id', user.id)
    .eq('status', 'pending_acceptance')
    .maybeSingle();

  if (!plan) return { error: 'Plan not found or already actioned.' };

  // Fetch profile (salary day + email needed later for Paystack)
  const { data: profile } = await supabase
    .from('profiles')
    .select('salary_day, email')
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

  if (await isBlockedFromNewPlan(user.id)) {
    return { error: 'Please complete your current payment plan before starting another.' };
  }

  // Calculate instalment schedule
  const totalAmount  = Number(plan.total_amount);
  const instalments  = splitInstalments(totalAmount, planType);
  const dates        = calculatePaymentDates(new Date(), salaryDay, planType);

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

  // Move plan to pending_first_payment and record the chosen schedule
  const { error: planError } = await supabase
    .from('plans')
    .update({
      status:            'pending_first_payment',
      plan_type:         planType,
      instalment_amount: instalments[0],
    })
    .eq('id', planId)
    .eq('patient_id', user.id);

  if (planError) return { error: planError.message };

  // Insert all payment rows — instalment 1 ID is pre-generated so we can use
  // it in the Paystack reference and store it before charging.
  const instalment1Id = crypto.randomUUID();
  const paymentRows   = instalments.map((amount, i) => ({
    id:                i === 0 ? instalment1Id : crypto.randomUUID(),
    plan_id:           planId,
    patient_id:        user.id,
    instalment_number: i + 1,
    amount,
    due_date:          dates[i].toISOString().split('T')[0],
    status:            i === 0 ? 'processing' : 'scheduled',
  }));

  const { error: paymentsError } = await supabase.from('payments').insert(paymentRows);
  if (paymentsError) {
    // Rollback plan
    await supabase.from('plans')
      .update({ status: 'pending_acceptance', plan_type: null, instalment_amount: null })
      .eq('id', planId);
    return { error: paymentsError.message };
  }

  if (plan.application_id) {
    await supabase
      .from('applications')
      .update({ plan_type: planType })
      .eq('id', plan.application_id as string);
  }

  // Reference stamped on the payment row BEFORE the charge so the
  // Peach webhook can reconcile even if our process crashes mid-flight.
  // Compact 16-char ref per Peach V2 mandate; this is a Flow-C-style
  // MIT charge but seeded off the instalment-1 id (not attempt-based —
  // there's no attempt counter here, it's a one-shot silent charge).
  const reference = checkoutRef(instalment1Id);

  const { error: refErr } = await supabase
    .from('payments')
    .update({ peach_payment_id: reference })
    .eq('id', instalment1Id)
    .eq('patient_id', user.id);

  if (refErr) {
    await supabase.from('payments').delete().eq('plan_id', planId);
    await supabase.from('plans')
      .update({ status: 'pending_acceptance', plan_type: null, instalment_amount: null })
      .eq('id', planId);
    return { error: refErr.message };
  }

  // Silent MIT charge against the saved card's registration id.
  // paymentMethod.token holds the Peach registrationId for newly-added
  // cards; the RPC-refresh path (0041) writes registrationIds into the
  // same column so this works uniformly.
  const amountCents = Math.round(instalments[0] * 100);

  // No plan-level initialTransactionId yet — this is the very first
  // MIT charge on this plan/card combination. UNSCHEDULED is Peach's
  // recommended type when the stored credential has no initial
  // reference to link to. On success we capture the payment id below
  // and stamp it as plan.peach_initial_transaction_id so subsequent
  // instalments upgrade to INSTALLMENT + initialTransactionId.
  const provider = getPaymentProvider();

  // ── DIAGNOSTIC LOG — pay-with-saved-card ──────────────────────────
  //
  // Two failure modes were possible when this call stalled on the
  // client "Charging…" state and we had no visibility:
  //   • paymentMethod.token was null/empty (never got vaulted — the
  //     COPYandPAY widget regression left plans with no card), OR
  //   • Peach returned a decline/error that the client wasn't
  //     surfacing.
  // Logging the outbound token + amount + reference under a
  // greppable prefix, and the raw provider response after, lets
  // future occurrences show up in Vercel logs directly. Sensitive
  // material (registrationId itself) is a token, not PAN — logging
  // it is standard practice on the Peach recurring surface.
  console.log('PEACH PAY-WITH-SAVED-CARD REQUEST:', {
    planId,
    paymentMethodId,
    registrationId: paymentMethod.token,
    hasToken:       !!paymentMethod.token,
    amountCents,
    merchantTransactionId: reference,
  });

  const chargeResult = await provider.chargeSavedCard({
    registrationId:        paymentMethod.token,
    amountCents,
    merchantTransactionId: reference,
    currency:              'ZAR',
    standingInstruction: {
      mode:   'REPEATED',
      source: 'MIT',
      type:   'UNSCHEDULED',
    },
  });

  console.log('PEACH PAY-WITH-SAVED-CARD RESPONSE:', {
    planId,
    status:               chargeResult.status,
    resultCode:           chargeResult.resultCode,
    resultDescription:    chargeResult.resultDescription,
    providerPaymentId:    chargeResult.providerPaymentId,
    initialTransactionId: chargeResult.initialTransactionId,
  });

  if (chargeResult.status === 'error' || chargeResult.status === 'rejected') {
    await supabase.from('payments').delete().eq('plan_id', planId);
    await supabase.from('plans')
      .update({ status: 'pending_acceptance', plan_type: null, instalment_amount: null })
      .eq('id', planId);
    return { error: chargeResult.resultDescription ?? 'Card was declined. Please try a different card.' };
  }

  // Stamp the reusable registration id (idempotent — the webhook may
  // land the same value in parallel).
  await supabase
    .from('plans')
    .update({ peach_registration_id: paymentMethod.token })
    .eq('id', planId)
    .eq('patient_id', user.id)
    .is('peach_registration_id', null);

  // Stamp peach_initial_transaction_id ONLY from Peach's echoed chain
  // root (standingInstruction.initialTransactionId on the MIT response).
  // Do NOT fall back to chargeResult.providerPaymentId — that is THIS
  // MIT's own id, not the CIT root that established the credential.
  // Threading an MIT-typed id as a later charge's `initialTransactionId`
  // is a compliance-shaped bug: Peach validates the reference against
  // the stored chain and rejects it, and because every writer of this
  // column is .is(...null)-guarded (write-once) the wrong value would
  // be locked in permanently.
  //
  // When the echo is absent, LEAVE THE COLUMN NULL. chargeInstalment
  // and settle-actions both fall back safely to UNSCHEDULED when
  // initialTransactionId is null — no data is better than wrong data.
  //
  // TODO(dina): confirm in sandbox which exact field Peach returns as
  // the valid initialTransactionId, and whether payWithSavedCard
  // should be REPEATED/CIT (customer present) rather than REPEATED/MIT.
  if (chargeResult.initialTransactionId) {
    await supabase
      .from('plans')
      .update({ peach_initial_transaction_id: chargeResult.initialTransactionId })
      .eq('id', planId)
      .eq('patient_id', user.id)
      .is('peach_initial_transaction_id', null);
  }

  // Charge is in-flight (pending) or succeeded — the webhook will
  // activate the plan on the terminal PAYMENT event.
  revalidatePath('/patient', 'layout');
  return { error: null, planId };
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

  revalidatePath('/patient', 'layout');
  return { error: null };
}
