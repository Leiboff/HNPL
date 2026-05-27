'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { splitInstalments, calculatePaymentDates } from '@/lib/finance';
import { paystackRequest } from '@/lib/paystack';

export async function acceptPlan(
  planId: string,
  planType: 2 | 3,
): Promise<{ error: string | null }> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

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

export async function initializeCardRegistration(): Promise<{
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
        callback_url: `${appUrl}/patient/payment-methods/complete`,
        metadata: {
          purpose:        'card_registration',
          patientId:      user.id,
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
