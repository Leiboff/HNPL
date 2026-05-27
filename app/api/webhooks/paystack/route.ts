// Node.js runtime required — we use crypto.createHmac and crypto.timingSafeEqual
// which are not available in the Edge runtime.
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { calculateFee } from '@/lib/finance';
import { paystackRequest } from '@/lib/paystack';

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
  signature?:          string;
};

type ChargeMetadata = {
  purpose?:   string;
  patientId?: string;
  [key: string]: unknown;
};

type ChargeData = {
  reference?:        string;
  amount?:           number;
  status?:           string;
  message?:          string;
  gateway_response?: string;
  authorization?:    Authorization;
  metadata?:         ChargeMetadata;
};

type PaystackPayload = {
  event: string;
  data:  ChargeData;
};

// ─── Shared card-save helper ──────────────────────────────────────────────────
// Used by both first-payment activation and card-registration flows.
// Throws on DB error so the caller can decide whether to treat it as fatal.

async function saveCardForPatient(
  patientId: string,
  auth: Authorization,
  supabase: ReturnType<typeof createServiceClient>,
): Promise<void> {
  const authCode      = auth.authorization_code!;
  const cardSignature = auth.signature ?? null;

  const { data: patientProfile } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .eq('id', patientId)
    .single();

  const cardholderName = patientProfile
    ? `${patientProfile.first_name} ${patientProfile.last_name}`.trim()
    : (auth.account_name ?? '');

  if (cardSignature) {
    const { data: existingPm } = await supabase
      .from('payment_methods')
      .select('id')
      .eq('patient_id', patientId)
      .eq('signature', cardSignature)
      .maybeSingle();

    if (existingPm) {
      const { error } = await supabase
        .from('payment_methods')
        .update({
          token:        authCode,
          card_brand:   auth.brand   ?? 'Card',
          last_four:    auth.last4   ?? '0000',
          expiry_month: Number(auth.exp_month ?? 0),
          expiry_year:  Number(auth.exp_year  ?? 0),
          reusable:     true,
        })
        .eq('id', existingPm.id);
      if (error) throw error;
    } else {
      const { count } = await supabase
        .from('payment_methods')
        .select('id', { count: 'exact', head: true })
        .eq('patient_id', patientId);

      const { error } = await supabase
        .from('payment_methods')
        .insert({
          patient_id:      patientId,
          card_brand:      auth.brand      ?? 'Card',
          last_four:       auth.last4      ?? '0000',
          expiry_month:    Number(auth.exp_month ?? 0),
          expiry_year:     Number(auth.exp_year  ?? 0),
          cardholder_name: cardholderName,
          token:           authCode,
          signature:       cardSignature,
          reusable:        true,
          is_default:      (count ?? 0) === 0,
        });
      if (error) throw error;
    }
  } else {
    // No signature (rare) — insert without dedup
    const { count } = await supabase
      .from('payment_methods')
      .select('id', { count: 'exact', head: true })
      .eq('patient_id', patientId);

    const { error } = await supabase
      .from('payment_methods')
      .insert({
        patient_id:      patientId,
        card_brand:      auth.brand      ?? 'Card',
        last_four:       auth.last4      ?? '0000',
        expiry_month:    Number(auth.exp_month ?? 0),
        expiry_year:     Number(auth.exp_year  ?? 0),
        cardholder_name: cardholderName,
        token:           authCode,
        signature:       null,
        reusable:        true,
        is_default:      (count ?? 0) === 0,
      });
    if (error) throw error;
  }
}

// ─── charge.success handler ───────────────────────────────────────────────────

async function handleChargeSuccess(data: ChargeData): Promise<void> {
  const reference = data.reference;
  const supabase  = createServiceClient();

  const { data: payment } = await supabase
    .from('payments')
    .select('id, plan_id, instalment_number, patient_id, status')
    .eq('peach_payment_id', reference)
    .maybeSingle();

  if (!payment) {
    console.warn('[paystack-webhook] charge.success: no payment row for reference', reference);
    return;
  }

  const { data: plan } = await supabase
    .from('plans')
    .select('id, status, total_amount, practice_id, patient_id')
    .eq('id', payment.plan_id)
    .maybeSingle();

  if (!plan) {
    console.error('[paystack-webhook] charge.success: plan not found', payment.plan_id);
    return;
  }

  const now = new Date().toISOString();

  // ── Instalment 1: first-payment activation ───────────────────────────────

  if (payment.instalment_number === 1) {
    // Idempotency: webhook fired again after we already activated
    if (plan.status === 'active') {
      console.log('[paystack-webhook] charge.success: plan already active (duplicate)', plan.id);
      return;
    }
    if (plan.status !== 'pending_first_payment') {
      console.warn('[paystack-webhook] charge.success: unexpected plan status for instalment 1', plan.status);
      return;
    }

    const auth = data.authorization;

    // Reusable guard — critical: a non-reusable card cannot be used for future debits
    if (!auth?.reusable) {
      console.warn('[paystack-webhook] charge.success: authorization not reusable — skipping activation', { reference });
      return;
    }

    const authCode = auth.authorization_code!;

    // Store the authorization code on the plan for future instalment charges
    const { error: authCodeErr } = await supabase
      .from('plans')
      .update({ paystack_authorization_code: authCode })
      .eq('id', plan.id);
    if (authCodeErr) {
      console.error('[paystack-webhook] charge.success: failed to store auth code', authCodeErr.message);
      return;
    }

    // Save the card — non-fatal; plan activation proceeds regardless.
    try {
      await saveCardForPatient(plan.patient_id, auth, supabase);
    } catch (pmSaveErr) {
      console.error(
        '[paystack-webhook] charge.success: failed to save payment_methods (non-fatal)',
        pmSaveErr instanceof Error ? pmSaveErr.message : pmSaveErr,
      );
    }

    const { error: pmtErr } = await supabase
      .from('payments')
      .update({ status: 'collected', collected_at: now })
      .eq('id', payment.id);
    if (pmtErr) {
      console.error('[paystack-webhook] charge.success: failed to mark instalment 1 collected', pmtErr.message);
      return;
    }

    const { error: planErr } = await supabase
      .from('plans')
      .update({ status: 'active' })
      .eq('id', plan.id);
    if (planErr) {
      console.error('[paystack-webhook] charge.success: failed to activate plan', planErr.message);
      return;
    }

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
      // Non-fatal — plan is active; payout can be reconciled via admin
      console.error('[paystack-webhook] charge.success: failed to insert payout', payoutErr.message);
    }

    console.log('[paystack-webhook] charge.success: plan activated', { planId: plan.id, reference });
    return;
  }

  // ── Instalments 2 / 3: recurring collection ──────────────────────────────

  // Idempotency: webhook fired again for an already-collected instalment
  if (payment.status === 'collected') {
    console.log('[paystack-webhook] charge.success: instalment already collected (duplicate)', { paymentId: payment.id, reference });
    return;
  }

  const { error: pmtErr } = await supabase
    .from('payments')
    .update({ status: 'collected', collected_at: now })
    .eq('id', payment.id);
  if (pmtErr) {
    console.error('[paystack-webhook] charge.success: failed to mark instalment collected', pmtErr.message);
    return;
  }

  // If every instalment is now collected, mark the plan completed
  const { data: remaining } = await supabase
    .from('payments')
    .select('id')
    .eq('plan_id', plan.id)
    .neq('status', 'collected');

  if (!remaining || remaining.length === 0) {
    await supabase
      .from('plans')
      .update({ status: 'completed', completed_at: now })
      .eq('id', plan.id);
    console.log('[paystack-webhook] charge.success: plan completed', { planId: plan.id });
  } else {
    console.log('[paystack-webhook] charge.success: instalment collected', {
      paymentId:        payment.id,
      instalmentNumber: payment.instalment_number,
      planId:           plan.id,
    });
  }
}

// ─── charge.failed handler ────────────────────────────────────────────────────

async function handleChargeFailed(data: ChargeData): Promise<void> {
  const reference = data.reference;
  const supabase  = createServiceClient();

  const { data: payment } = await supabase
    .from('payments')
    .select('id, plan_id, instalment_number, status')
    .eq('peach_payment_id', reference)
    .maybeSingle();

  if (!payment) {
    console.warn('[paystack-webhook] charge.failed: no payment row for reference', reference);
    return;
  }

  const { data: plan } = await supabase
    .from('plans')
    .select('id, status')
    .eq('id', payment.plan_id)
    .maybeSingle();

  if (!plan) {
    console.error('[paystack-webhook] charge.failed: plan not found', payment.plan_id);
    return;
  }

  const failureReason = data.gateway_response ?? data.message ?? 'Charge failed';

  // ── Instalment 1: cancel the plan (patient never paid; practice not yet paid) ──

  if (payment.instalment_number === 1) {
    if (plan.status === 'cancelled') {
      console.log('[paystack-webhook] charge.failed: plan already cancelled (duplicate)', plan.id);
      return;
    }
    if (plan.status !== 'pending_first_payment') {
      console.warn('[paystack-webhook] charge.failed: unexpected plan status for instalment 1', plan.status);
      return;
    }

    const { error: pmtErr } = await supabase
      .from('payments')
      .update({ status: 'failed', failure_reason: failureReason })
      .eq('id', payment.id);
    if (pmtErr) {
      console.error('[paystack-webhook] charge.failed: failed to mark instalment 1 failed', pmtErr.message);
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
    return;
  }

  // ── Instalments 2 / 3: mark failed, leave plan active ────────────────────
  // The practice payout is already created; this is HNPL's collection risk.

  if (payment.status === 'failed') {
    console.log('[paystack-webhook] charge.failed: instalment already marked failed (duplicate)', { paymentId: payment.id, reference });
    return;
  }

  const { error: pmtErr } = await supabase
    .from('payments')
    .update({ status: 'failed', failure_reason: failureReason })
    .eq('id', payment.id);
  if (pmtErr) {
    console.error('[paystack-webhook] charge.failed: failed to mark instalment failed', pmtErr.message);
    return;
  }

  console.log('[paystack-webhook] charge.failed: instalment failed (plan remains active)', {
    paymentId:        payment.id,
    instalmentNumber: payment.instalment_number,
    planId:           plan.id,
    failureReason,
  });
}

// ─── card_registration handlers ──────────────────────────────────────────────

async function handleCardRegistrationSuccess(data: ChargeData): Promise<void> {
  const reference = data.reference;
  const patientId = data.metadata?.patientId;
  const supabase  = createServiceClient();
  const auth      = data.authorization;

  if (!patientId) {
    console.error('[paystack-webhook] card_registration: missing patientId in metadata', { reference });
    // Still refund — we don't keep money we can't attribute
  }

  if (patientId && auth?.reusable) {
    try {
      await saveCardForPatient(patientId, auth, supabase);
      console.log('[paystack-webhook] card_registration: card saved', { patientId, reference });
    } catch (err) {
      console.error(
        '[paystack-webhook] card_registration: failed to save card (non-fatal)',
        err instanceof Error ? err.message : err,
      );
    }
  } else if (!auth?.reusable) {
    console.warn('[paystack-webhook] card_registration: card not reusable — skipping save', { reference });
  }

  // Always refund the R1 charge, regardless of whether the card was saved
  try {
    await paystackRequest('/refund', {
      method: 'POST',
      body:   JSON.stringify({ transaction: reference }),
    });
    console.log('[paystack-webhook] card_registration: R1 refund initiated', { reference });
  } catch (refundErr) {
    console.error(
      '[paystack-webhook] card_registration: refund FAILED — manual follow-up needed',
      refundErr instanceof Error ? refundErr.message : refundErr,
      { reference },
    );
  }
}

function handleCardRegistrationFailed(data: ChargeData): void {
  // Charge never went through — nothing to refund, nothing to save
  console.log('[paystack-webhook] card_registration: charge failed — no action needed', {
    reference: data.reference,
    reason:    data.gateway_response ?? data.message ?? 'unknown',
  });
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
  // Branch first on metadata.purpose so card-registration events never reach
  // the plan-payment handlers. Handlers are awaited before returning 200.
  const purpose = data.metadata?.purpose;

  if (purpose === 'card_registration') {
    if (event === 'charge.success') {
      await handleCardRegistrationSuccess(data);
    } else if (event === 'charge.failed') {
      handleCardRegistrationFailed(data);
    } else {
      console.log('[paystack-webhook] card_registration: unhandled event — ignoring:', event);
    }
  } else if (event === 'charge.success') {
    await handleChargeSuccess(data);
  } else if (event === 'charge.failed') {
    await handleChargeFailed(data);
  } else {
    console.log('[paystack-webhook] Unhandled event type — ignoring:', event);
  }

  // ── 5. Acknowledge ──────────────────────────────────────────────────────────
  return NextResponse.json({ received: true }, { status: 200 });
}
