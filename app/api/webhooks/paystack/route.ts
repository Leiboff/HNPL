// Node.js runtime required — we use crypto.createHmac and crypto.timingSafeEqual
// which are not available in the Edge runtime.
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

// Note: the middleware (proxy.ts / updateSession) only refreshes Supabase session
// cookies and never redirects — so this unauthenticated route is unaffected by it.

type PaystackPayload = {
  event: string;
  data: {
    reference?:      string;
    amount?:         number;
    status?:         string;
    authorization?: {
      authorization_code?: string;
      reusable?:           boolean;
    };
  };
};

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

  // ── 3. Parse and log ────────────────────────────────────────────────────────
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

  // ── 4. Acknowledge receipt ──────────────────────────────────────────────────
  // Return 200 quickly. Paystack retries if it doesn't receive 200 promptly.
  // Database writes and business logic will be added here once verified working.
  return NextResponse.json({ received: true }, { status: 200 });
}
