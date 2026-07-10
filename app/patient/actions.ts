'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { splitInstalments, calculatePaymentDates } from '@/lib/finance';
import { paystackRequest } from '@/lib/paystack';
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
): Promise<{ error: string | null; authorizationUrl?: string }> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  // Verify plan belongs to this patient and is waiting for first payment
  const { data: plan } = await supabase
    .from('plans')
    .select('id, status')
    .eq('id', planId)
    .eq('patient_id', user.id)
    .eq('status', 'pending_first_payment')
    .maybeSingle();

  if (!plan) return { error: 'Plan not found or not ready for payment.' };

  // Fetch the first instalment payment row
  const { data: payment } = await supabase
    .from('payments')
    .select('id, amount')
    .eq('plan_id', planId)
    .eq('patient_id', user.id)
    .eq('instalment_number', 1)
    .maybeSingle();

  if (!payment) return { error: 'First instalment not found.' };

  // Fetch patient email (Paystack requires it)
  const { data: profile } = await supabase
    .from('profiles')
    .select('email')
    .eq('id', user.id)
    .single();

  if (!profile?.email) return { error: 'Account email not found.' };

  // Derive a stable unique reference from the payment ID so the webhook can look it up
  const reference = `hnpl_${payment.id.replace(/-/g, '').slice(0, 20)}`;

  // Paystack amounts are in the smallest currency unit (cents for ZAR)
  const amountCents = Math.round(Number(payment.amount) * 100);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  type InitResponse = {
    status: boolean;
    message: string;
    data: { authorization_url: string; access_code: string; reference: string };
  };

  let initData: InitResponse['data'];
  try {
    const result = await paystackRequest<InitResponse>('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email:        profile.email,
        amount:       amountCents,
        currency:     'ZAR',
        reference,
        // Card-only: required so Paystack creates a reusable authorization for future debits
        channels:     ['card'],
        callback_url: `${appUrl}/patient/payment-complete`,
        metadata: {
          planId,
          paymentId:         payment.id,
          instalment_number: 1,
          // custom_filters tells the Paystack popup to only offer recurring-capable cards
          custom_filters: { reusable: true },
        },
      }),
    });

    if (!result.status) {
      return { error: result.message ?? 'Failed to initialize payment.' };
    }
    initData = result.data;
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to initialize payment.' };
  }

  // Persist the Paystack reference on the payment row so the webhook can find it
  const { error: updateError } = await supabase
    .from('payments')
    .update({ peach_payment_id: initData.reference })
    .eq('id', payment.id)
    .eq('patient_id', user.id);

  if (updateError) return { error: updateError.message };

  return { error: null, authorizationUrl: initData.authorization_url };
}

export async function initializeCardRegistration(returnTo?: string): Promise<{
  error: string | null;
  authorizationUrl?: string;
}> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('email')
    .eq('id', user.id)
    .single();

  if (!profile?.email) return { error: 'Account email not found.' };

  const reference = `hnpl_cardreg_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  // Only accept relative paths — no full URLs, no external redirects.
  const safePath = (returnTo && returnTo.startsWith('/'))
    ? returnTo
    : '/patient/payment-methods/complete';

  type InitResponse = {
    status:  boolean;
    message: string;
    data: { authorization_url: string; access_code: string; reference: string };
  };

  try {
    const result = await paystackRequest<InitResponse>('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email:        profile.email,
        amount:       100,
        currency:     'ZAR',
        reference,
        channels:     ['card'],
        callback_url: `${appUrl}${safePath}`,
        metadata: {
          purpose:        'card_registration',
          patientId:      user.id,
          return_to:      safePath,
          custom_filters: { reusable: true },
        },
      }),
    });

    if (!result.status) {
      return { error: result.message ?? 'Failed to initialize card registration.' };
    }

    return { error: null, authorizationUrl: result.data.authorization_url };
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

  // Store the Paystack reference on the payment row BEFORE charging so the
  // webhook can look up the row even if our process crashes after the charge.
  const reference = `hnpl_pay_${instalment1Id.replace(/-/g, '').slice(0, 20)}`;

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

  // Charge the saved card silently — no checkout redirect needed
  const amountCents = Math.round(instalments[0] * 100);

  type ChargeAuthResponse = {
    status:   boolean;
    message:  string;
    data?: {
      status:    string;
      reference: string;
      amount:    number;
    };
  };

  let chargeResult: ChargeAuthResponse;
  try {
    chargeResult = await paystackRequest<ChargeAuthResponse>('/transaction/charge_authorization', {
      method: 'POST',
      body: JSON.stringify({
        authorization_code: paymentMethod.token,
        email:              profile.email,
        amount:             amountCents,
        currency:           'ZAR',
        reference,
        metadata: {
          purpose:           'first_instalment_silent',
          planId,
          paymentId:         instalment1Id,
          instalment_number: 1,
        },
      }),
    });
  } catch (err) {
    // Network / API error — roll everything back so the patient can retry
    await supabase.from('payments').delete().eq('plan_id', planId);
    await supabase.from('plans')
      .update({ status: 'pending_acceptance', plan_type: null, instalment_amount: null })
      .eq('id', planId);
    return { error: err instanceof Error ? err.message : 'Failed to charge card.' };
  }

  // If Paystack immediately declines, roll back and surface the reason
  if (!chargeResult.status || chargeResult.data?.status === 'failed') {
    await supabase.from('payments').delete().eq('plan_id', planId);
    await supabase.from('plans')
      .update({ status: 'pending_acceptance', plan_type: null, instalment_amount: null })
      .eq('id', planId);
    return { error: chargeResult.message ?? 'Card was declined. Please try a different card.' };
  }

  // Charge is in-flight or succeeded — the webhook will activate the plan.
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
