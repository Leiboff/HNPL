// Node runtime required — crypto.createHmac + timingSafeEqual are not
// available in the Edge runtime.
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { verifyDiditWebhookSignature } from '@/lib/didit/webhook';
import { validateSaId, saIdAge } from '@/lib/validation';
import { encryptId, hashIdForLookup } from '@/lib/idEncryption';
import { findPatientBySaId } from '@/lib/patients/findPatientBySaId';
import type { DiditWebhookEvent } from '@/lib/didit/types';

// ─── Didit webhook receiver — onboarding identity verification ─────────
//
// Backs the merged "identity + liveness" onboarding step
// (lib/onboarding/actions.ts::startIdentityVerification creates the
// session; this route applies the decision).
//
// On `status.updated` with status "Approved":
//   • Extract decision.id_verifications[0].personal_number — for a South
//     African ID document this IS the 13-digit SA ID number.
//   • Re-validate it with the SAME validateSaId/saIdAge rules the old
//     manual-entry path used (Luhn + DOB + citizenship + 18+). Didit
//     verified the document is genuine and matches the live face; it
//     does not know our SA-ID-specific business rules.
//   • Re-run the SAME "one SA ID = one account" duplicate check
//     (findPatientBySaId) the manual path used — a Didit session can't
//     bypass that invariant just because it arrived a different way.
//   • On success, write sa_id_number + sa_id_lookup_hash (identity step)
//     AND liveness_verified_at (liveness step) in one update — the
//     state model (lib/onboarding/state.ts) needs no changes: both
//     steps read those same columns regardless of how they got filled.
//
// Every other status maps to identity_verification_status for UI
// purposes only; it never blocks or advances onboarding by itself.
//
// Always returns 2xx once the signature verifies, even if the handler
// throws — Didit retries 5xx/timeouts twice, and a real bug should not
// turn into a retry storm. A bad/missing signature is the one case that
// gets a non-2xx (401), since that delivery was never authenticated.

function svc() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const TERMINAL_STATUS: Partial<Record<DiditWebhookEvent['status'], string>> = {
  'Declined':    'declined',
  'In Review':   'in_review',
  'Abandoned':   'abandoned',
  'Expired':     'expired',
  'Kyc Expired': 'expired',
};

/**
 * Atomic dedupe: the INSERT's primary-key violation (23505) IS the "have
 * we seen this event_id before" check — no separate SELECT, so two
 * concurrent deliveries of the same retried event can't both pass.
 */
async function alreadyProcessed(supabase: SupabaseClient, eventId: string): Promise<boolean> {
  const { error } = await supabase.from('didit_webhook_events').insert({ event_id: eventId });
  if (!error) return false;
  if ((error as { code?: string }).code === '23505') return true;
  console.error('[didit-webhook] idempotency ledger insert failed (non-fatal, may reprocess)', error.message);
  return false;
}

// A short machine-readable code for WHY a session was declined, stored
// alongside identity_verification_status so the client can show the
// right copy — in particular, DUPLICATE_ID gets the SAME "an account
// already exists… Forgot password…" guidance the manual entry path
// (app/checkout/[token]/actions.ts) and the old saveIdAndSalaryDay used,
// rather than stranding a returning patient behind a generic failure.
const DUPLICATE_ID_MESSAGE =
  'An account already exists for this ID number. Please log in to that account instead — ' +
  'use "Forgot password" if you can\'t get in, or contact support if you think this is a mistake.';

async function markStatus(
  supabase: SupabaseClient,
  userId:   string,
  status:   string,
  reason?:  string,
): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({
      identity_verification_status:     status,
      identity_verification_reason:     reason ?? null,
      identity_verification_updated_at: new Date().toISOString(),
    })
    .eq('id', userId);
  if (error) {
    console.error('[didit-webhook] failed to write identity_verification_status', { userId, status, error: error.message });
  }
}

async function handleApproved(supabase: SupabaseClient, userId: string, event: DiditWebhookEvent): Promise<void> {
  const cleanedId = event.decision?.id_verifications?.[0]?.personal_number?.replace(/\s+/g, '') ?? null;

  if (!cleanedId) {
    console.warn('[didit-webhook] Approved session carried no personal_number', { userId, sessionId: event.session_id });
    await markStatus(supabase, userId, 'declined', 'no_id_extracted');
    return;
  }

  const check = validateSaId(cleanedId);
  if (!check.valid) {
    console.warn('[didit-webhook] extracted ID failed SA ID validation', { userId, sessionId: event.session_id, reason: check.reason });
    await markStatus(supabase, userId, 'declined', 'invalid_id');
    return;
  }

  const age = saIdAge(cleanedId);
  if (age === null || age < 18) {
    console.warn('[didit-webhook] extracted ID indicates under-18', { userId, sessionId: event.session_id });
    await markStatus(supabase, userId, 'declined', 'underage');
    return;
  }

  // Same invariant the manual entry path enforced — see the matching
  // comment in app/checkout/[token]/actions.ts. That path could show
  // "An account already exists for this ID number" synchronously in a
  // form; this webhook can't show the patient anything directly, so the
  // SAME copy is stored as identity_verification_reason='id_already_registered'
  // for the client to render instead — the deliberate divergence from
  // findExistingAuthUser's anti-enumeration posture on email applies here
  // too (see that file for the full reasoning); it does not become less
  // deliberate for arriving async.
  let idOwner: Awaited<ReturnType<typeof findPatientBySaId>>;
  try {
    idOwner = await findPatientBySaId(supabase, cleanedId);
  } catch (err) {
    // Lookup failure — do NOT write a possibly-duplicate ID. Leave the
    // status as-is (pending); the delivery is not acknowledged as
    // "handled" beyond the 2xx, so this is a case worth alerting on.
    // (SA ID duplicate check failed — we could not verify your ID number
    // just now, so we refuse rather than risk writing a duplicate.)
    console.error('[didit-webhook] ALERT SA ID duplicate check failed — could not verify your ID number, approved session not persisted', {
      userId, sessionId: event.session_id, error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (idOwner && idOwner.id !== userId) {
    console.warn(`[didit-webhook] ${DUPLICATE_ID_MESSAGE}`, { userId, ownerId: idOwner.id });
    await markStatus(supabase, userId, 'declined', 'id_already_registered');
    return;
  }

  let encrypted: string;
  let lookupHash: string;
  try {
    encrypted  = encryptId(cleanedId);
    lookupHash = hashIdForLookup(cleanedId);
  } catch (err) {
    console.error('[didit-webhook] ALERT encryption failed — approved session not persisted', {
      userId, error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from('profiles')
    .update({
      sa_id_number:                     encrypted,
      sa_id_lookup_hash:                lookupHash,
      liveness_verified_at:             now,
      identity_verification_status:     'approved',
      identity_verification_reason:     null,
      identity_verification_updated_at: now,
    })
    .eq('id', userId);
  if (error) {
    console.error('[didit-webhook] ALERT failed to persist approved identity verification', { userId, error: error.message });
  }
}

export async function POST(request: NextRequest) {
  const secret = process.env.DIDIT_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[didit-webhook] DIDIT_WEBHOOK_SECRET is not set — cannot verify event');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const raw = await request.text();
  let parsed: DiditWebhookEvent;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Malformed JSON body' }, { status: 400 });
  }

  const valid = verifyDiditWebhookSignature({
    parsedBody: parsed,
    signature:  request.headers.get('x-signature-v2'),
    timestamp:  request.headers.get('x-timestamp'),
    secret,
  });
  if (!valid) {
    console.warn('[didit-webhook] signature verification failed — 401');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const supabase = svc();

  if (parsed.event_id && (await alreadyProcessed(supabase, parsed.event_id))) {
    return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
  }

  console.log('[didit-webhook] event received', {
    webhookType: parsed.webhook_type,
    status:      parsed.status,
    sessionId:   parsed.session_id,
    environment: parsed.environment,
  });

  // Only session status changes on a session we tied to a user
  // (vendor_data) carry a decision we act on. data.updated / anything
  // else is acknowledged and ignored.
  if (parsed.webhook_type === 'status.updated' && parsed.vendor_data) {
    const userId = parsed.vendor_data;
    try {
      if (parsed.status === 'Approved') {
        await handleApproved(supabase, userId, parsed);
      } else {
        const mapped = TERMINAL_STATUS[parsed.status];
        if (mapped) await markStatus(supabase, userId, mapped);
        // Not Started / In Progress / Awaiting User / Resubmitted —
        // nothing to persist; the user is mid-flow.
      }
    } catch (err) {
      console.error('[didit-webhook] ALERT handler threw', {
        userId, sessionId: parsed.session_id, status: parsed.status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
