// Node.js runtime required — we use crypto.createHmac and crypto.timingSafeEqual
// which are not available in the Edge runtime.
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { calculateFee } from '@/lib/finance';

// Note: the middleware (proxy.ts / updateSession) only refreshes Supabase session
// cookies and never redirects — so this unauthenticated route is unaffected by it.

// ─── Service-role client ──────────────────────────────────────────────────────
// Bypasses RLS — correct here because the request is authenticated by Paystack's
// HMAC signature above, not by a user session. Never expose this key.

function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ─── Paystack types ───────────────────────────────────────────────────────────

type Authorization = {
  authorization_code?: string;
  last4?:              string;
  exp_month?:          string | number;
  exp_year?:           string | number;
  brand?:              string;
  reusable?:           boolean;
  account_name?:       string;
};

type ChargeData = {
  reference?:        string;
  amount?:           number;
  status?:           string;
  message?:          string;
  gateway_response?: string;
  authorization?:    Authorization;
};

type PaystackPayload = {
  event: string;
  data:  ChargeData;
};

// ─── charge.success handler ───────────────────────────────────────────────────

async function handleChargeSuccess(data: ChargeData): Promise<void> {
  const reference   = data.reference;
  const auth        = data.authorization;

  // Reusable check — critical: a non-reusable authorization cannot be used for
  // future instalment debits. Do not activate the plan in this case.
  if (!auth?.reusable) {
    console.warn('[paystack-webhook] charge.success: authorization not reusable — skipping activation', { reference });
    return;
  }

  const supabase = createServiceClient();

  // Find the payment row by the Paystack reference we stored earlier
  const { data: payment } = await supabase
    .from('payments')
    .select('id, plan_id, instalment_number, patient_id')
    .eq('peach_payment_id', reference)
    .maybeSingle();

  if (!payment) {
    console.warn('[paystack-webhook] charge.success: no payment row for reference', reference);
    return;
  }

  if (payment.instalment_number !== 1) {
    console.warn('[paystack-webhook] charge.success: reference matched instalment', payment.instalment_number, '— expected 1');
    return;
  }

  // Fetch the plan
  const { data: plan } = await supabase
    .from('plans')
    .select('id, status, total_amount, practice_id, patient_id')
    .eq('id', payment.plan_id)
    .maybeSingle();

  if (!plan) {
    console.error('[paystack-webhook] charge.success: plan not found for plan_id', payment.plan_id);
    return;
  }

  // Idempotency: duplicate webhook after we already activated
  if (plan.status === 'active') {
    console.log('[paystack-webhook] charge.success: plan already active — ignoring duplicate', plan.id);
    return;
  }

  if (plan.status !== 'pending_first_payment') {
    console.warn('[paystack-webhook] charge.success: plan in unexpected status', plan.status, '— ignoring');
    return;
  }

  const authCode = auth.authorization_code!;
  const now      = new Date().toISOString();

  // Store the authorization code on the plan for future instalment debits
  const { error: authCodeErr } = await supabase
    .from('plans')
    .update({ paystack_authorization_code: authCode })
    .eq('id', plan.id);
  if (authCodeErr) {
    console.error('[paystack-webhook] charge.success: failed to store auth code', authCodeErr.message);
    return;
  }

  // Upsert a payment_methods row (skip if this token already exists for this patient)
  const { data: existingPm } = await supabase
    .from('payment_methods')
    .select('id')
    .eq('patient_id', plan.patient_id)
    .eq('token', authCode)
    .maybeSingle();

  if (!existingPm) {
    // Use the patient's profile name as the cardholder name
    const { data: patientProfile } = await supabase
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', plan.patient_id)
      .single();

    const cardholderName = patientProfile
      ? `${patientProfile.first_name} ${patientProfile.last_name}`.trim()
      : (auth.account_name ?? '');

    // First card for this patient becomes the default
    const { count } = await supabase
      .from('payment_methods')
      .select('id', { count: 'exact', head: true })
      .eq('patient_id', plan.patient_id);

    const { error: pmErr } = await supabase
      .from('payment_methods')
      .insert({
        patient_id:      plan.patient_id,
        card_brand:      auth.brand      ?? 'Card',
        last_four:       auth.last4      ?? '0000',
        expiry_month:    Number(auth.exp_month ?? 0),
        expiry_year:     Number(auth.exp_year  ?? 0),
        cardholder_name: cardholderName,
        token:           authCode,
        is_default:      (count ?? 0) === 0,
        reusable:        true,
      });

    if (pmErr) {
      // Non-fatal — the plan can still activate even if the card row fails
      console.error('[paystack-webhook] charge.success: failed to upsert payment_methods', pmErr.message);
    }
  }

  // Mark instalment 1 collected
  const { error: pmtErr } = await supabase
    .from('payments')
    .update({ status: 'collected', collected_at: now })
    .eq('id', payment.id);
  if (pmtErr) {
    console.error('[paystack-webhook] charge.success: failed to mark payment collected', pmtErr.message);
    return;
  }

  // Activate the plan
  const { error: planErr } = await supabase
    .from('plans')
    .update({ status: 'active' })
    .eq('id', plan.id);
  if (planErr) {
    console.error('[paystack-webhook] charge.success: failed to activate plan', planErr.message);
    return;
  }

  // Create the practice payout
  const { data: practice } = await supabase
    .from('practices')
    .select('fee_percent')
    .eq('id', plan.practice_id as string)
    .single();

  const feePercent = Number(practice?.fee_percent ?? 6);
  const { gross, fee, net } = calculateFee(Number(plan.total_amount), feePercent);

  const { error: payoutErr } = await supabase
    .from('payouts')
    .insert({
      id:           crypto.randomUUID(),
      practice_id:  plan.practice_id as string,
      plan_id:      plan.id,
      gross_amount: gross,
      fee_amount:   fee,
      net_amount:   net,
      status:       'pending',
    });
  if (payoutErr) {
    console.error('[paystack-webhook] charge.success: failed to insert payout', payoutErr.message);
    // Plan is already active — payout can be created manually via admin
  }

  console.log('[paystack-webhook] charge.success: plan activated', { planId: plan.id, reference });
}

// ─── charge.failed handler ────────────────────────────────────────────────────

async function handleChargeFailed(data: ChargeData): Promise<void> {
  const reference = data.reference;
  const supabase  = createServiceClient();

  const { data: payment } = await supabase
    .from('payments')
    .select('id, plan_id, instalment_number')
    .eq('peach_payment_id', reference)
    .maybeSingle();

  if (!payment) {
    console.warn('[paystack-webhook] charge.failed: no payment row for reference', reference);
    return;
  }

  if (payment.instalment_number !== 1) {
    console.warn('[paystack-webhook] charge.failed: reference matched instalment', payment.instalment_number, '— expected 1');
    return;
  }

  const { data: plan } = await supabase
    .from('plans')
    .select('id, status')
    .eq('id', payment.plan_id)
    .maybeSingle();

  if (!plan) {
    console.error('[paystack-webhook] charge.failed: plan not found for plan_id', payment.plan_id);
    return;
  }

  // Idempotency: duplicate webhook after we already cancelled
  if (plan.status === 'cancelled') {
    console.log('[paystack-webhook] charge.failed: plan already cancelled — ignoring duplicate', plan.id);
    return;
  }

  if (plan.status !== 'pending_first_payment') {
    console.warn('[paystack-webhook] charge.failed: plan in unexpected status', plan.status, '— ignoring');
    return;
  }

  const failureReason = data.gateway_response ?? data.message ?? 'First payment failed';

  const { error: pmtErr } = await supabase
    .from('payments')
    .update({ status: 'failed', failure_reason: failureReason })
    .eq('id', payment.id);
  if (pmtErr) {
    console.error('[paystack-webhook] charge.failed: failed to mark payment failed', pmtErr.message);
    return;
  }

  const { error: planErr } = await supabase
    .from('plans')
    .update({ status: 'cancelled' })
    .eq('id', plan.id);
  if (planErr) {
    console.error('[paystack-webhook] charge.failed: failed to cancel plan', planErr.message);
    return;
  }

  console.log('[paystack-webhook] charge.failed: plan cancelled', { planId: plan.id, reference, failureReason });
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // ── 1. Read raw body as text BEFORE any JSON parsing ───────────────────────
  // Paystack signs the raw bytes; parsing first would invalidate the signature.
  const rawBody = await request.text();

  // ── 2. Signature verification ───────────────────────────────────────────────
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    console.error('[paystack-webhook] PAYSTACK_SECRET_KEY is not set');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const receivedSig = request.headers.get('x-paystack-signature') ?? '';
  const expectedSig = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');

  // timingSafeEqual requires equal-length buffers.
  // Buffer.from(<str>, 'hex') silently drops non-hex chars, producing a shorter
  // buffer — the length check below catches that safely.
  const receivedBuf = Buffer.from(receivedSig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');

  const signatureValid =
    receivedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(receivedBuf, expectedBuf);

  if (!signatureValid) {
    console.warn('[paystack-webhook] Invalid signature — request ignored');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // ── 3. Parse ────────────────────────────────────────────────────────────────
  let payload: PaystackPayload;
  try {
    payload = JSON.parse(rawBody) as PaystackPayload;
  } catch {
    console.error('[paystack-webhook] Failed to parse JSON body');
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { event, data } = payload;

  console.log('[paystack-webhook] Event received:', {
    event,
    reference:          data.reference,
    amount:             data.amount,
    status:             data.status,
    authorization_code: data.authorization?.authorization_code,
    reusable:           data.authorization?.reusable,
  });

  // ── 4. Dispatch ─────────────────────────────────────────────────────────────
  // Handlers are awaited before returning 200 — all DB writes are fast enough
  // that this stays well within Paystack's timeout window.
  if (event === 'charge.success') {
    await handleChargeSuccess(data);
  } else if (event === 'charge.failed') {
    await handleChargeFailed(data);
  } else {
    console.log('[paystack-webhook] Unhandled event type — ignoring:', event);
  }

  // ── 5. Acknowledge ──────────────────────────────────────────────────────────
  return NextResponse.json({ received: true }, { status: 200 });
}
