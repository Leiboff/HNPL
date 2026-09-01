// Node runtime required — crypto.createHmac + timingSafeEqual are not
// available in the Edge runtime.
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { verifyDiditWebhookSignature } from '@/lib/didit/webhook';
import { validateSaId, saIdAge } from '@/lib/validation';
import { encryptId, decryptId, hashIdForLookup } from '@/lib/idEncryption';
import { findPatientBySaId } from '@/lib/patients/findPatientBySaId';
import type { DiditWebhookEvent } from '@/lib/didit/types';

// ─── Didit webhook receiver — onboarding identity verification ─────────
//
// Backs the merged "identity + liveness" onboarding step. TWO paths feed
// this route now (lib/onboarding/dhaVerification.ts decides which one a
// given patient took, BEFORE any session exists):
//
//   OCR fallback — handleApprovedOcr. UNCHANGED from before the DHA path
//   existed: extracts decision.id_verifications[0].personal_number,
//   re-validates it (Luhn/DOB/citizenship/18+), re-runs the one-SA-ID-
//   per-account check, writes sa_id_number + liveness_verified_at.
//
//   DHA — handleApprovedDha. The SA ID was already typed, DHA-matched
//   and consent-gated BEFORE the session existed (see
//   lib/onboarding/actions.ts::submitIdentityForVerification), so this
//   handler has no id_verifications to read at all. What it DOES check,
//   independently of Didit's own session status, is decision.face_
//   matches[0].score — on this path the face match against the DHA
//   registry photo IS the entire identity binding, so trusting the
//   session's top-level status alone would mean approving without ever
//   inspecting the one check that matters. Score persisted on every
//   outcome (approve/review/decline), not just approvals — the
//   approve/review thresholds are env-driven placeholders that need a
//   real score distribution to tune; without persisting declines and
//   reviews too, that distribution is unrecoverable.
//
// WHICH HANDLER RUNS is decided by the STORED identity_verification_path
// column, never by comparing the envelope's workflow_id to an env var —
// that comparison breaks on env var rotation, workflow republishing, or
// any session in flight across a config change, and breaks SILENTLY (by
// applying the wrong path's logic to the decision). workflow_id is used
// only as a cross-check against the stored path; a disagreement between
// the two is never resolved by guessing — it routes to review and logs
// loudly (see resolveVerificationPath below).
//
// AML — moved out of the Didit workflow graph entirely (it requires OCR
// or KYB_REGISTRY, which the DHA-path workflow has neither) and called
// standalone on BOTH paths from handleApprovedOcr/Dha, using OCR-
// extracted name/DOB on the OCR path and the DHA-registry name on the
// DHA path. A hit — or the AML call itself failing — downgrades to
// in_review; it is never grounds for auto-decline (AML matches need
// human review) and never silently skipped (a failed compliance check
// is not the same shape of problem as an unavailable registry, and gets
// no fallback of its own).
//
// Every other status maps to identity_verification_status for UI
// purposes only; it never blocks or advances onboarding by itself.
//
// Always returns 2xx once the signature verifies, even if the handler
// throws — Didit retries 5xx/timeouts twice, and a real bug should not
// turn into a retry storm. The two exceptions: a bad/missing signature
// (401, that delivery was never authenticated) and a TRANSIENT failure
// in the duplicate-SA-ID lookup itself (500, see
// TransientDuplicateCheckError below) — a genuine duplicate match is a
// normal, non-throwing outcome (declined/200); the lookup ITSELF failing
// (DB/network error) is the only thing that throws, and that is
// transient by construction, not a decision about the applicant.

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
 *
 * ─── The claim is RELEASED when the handler asks for a retry ───────────
 *
 * THE DEFECT (audit 2026-09-01, F-13)
 *
 * The claim is taken BEFORE the handler runs, which is what makes the
 * concurrency property above work. But the handler has one deliberate
 * failure path — TransientDuplicateCheckError — that returns 500 SO THAT
 * DIDIT RETRIES. The retry re-entered here, found the row this same
 * delivery had just written, and returned {duplicate: true} with a 200.
 *
 * So a transient database blip inside findPatientBySaId permanently lost
 * that verification. The applicant's Didit session reads Approved; their
 * profile never gets sa_id_number or liveness_verified_at; they sit at the
 * identity step forever with nothing logged as an error, because from this
 * route's point of view everything worked.
 *
 * releaseEventClaim undoes the claim on exactly that path, so the retry it
 * asked for is actually able to do something. It is NOT called on the
 * generic catch below: an unexpected throw is a bug, that path answers 200
 * and does not want a retry storm, and holding the claim is correct there.
 *
 * (The Peach receiver, added later, records its delivery id on the way OUT
 * for this reason. Both orderings are defensible; what is not defensible is
 * claiming first and never releasing.)
 */
async function alreadyProcessed(supabase: SupabaseClient, eventId: string): Promise<boolean> {
  const { error } = await supabase.from('didit_webhook_events').insert({ event_id: eventId });
  if (!error) return false;
  if ((error as { code?: string }).code === '23505') return true;
  console.error('[didit-webhook] idempotency ledger insert failed (non-fatal, may reprocess)', error.message);
  return false;
}

async function releaseEventClaim(supabase: SupabaseClient, eventId: string): Promise<void> {
  const { error } = await supabase.from('didit_webhook_events').delete().eq('event_id', eventId);
  if (error) {
    // The retry will now be answered as a duplicate and the verification
    // will be lost — the exact F-13 outcome. Nothing here can fix it, so
    // it is logged at ALERT for a human to finish by hand.
    console.error('[didit-webhook] ALERT could not release the idempotency claim before a retry', {
      eventId, error: error.message,
      note: 'the retry will be treated as a duplicate; this verification needs manual completion',
    });
  }
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

/**
 * Thrown ONLY when the duplicate-SA-ID lookup itself fails (a DB/network
 * error inside findPatientBySaId) — NEVER for a genuine duplicate match,
 * which is a normal non-throwing return (idOwner.id !== userId) handled
 * as a declined/200 outcome. Caught in POST and mapped to 500 so Didit
 * retries; every other thrown error in this file stays 200 (see the
 * file banner) — this is the one deliberate exception.
 */
class TransientDuplicateCheckError extends Error {}

function envelopeFields(event: DiditWebhookEvent) {
  return {
    identity_verification_workflow_id:      event.workflow_id      ?? null,
    identity_verification_workflow_version: event.workflow_version ?? null,
    identity_verification_environment:      event.environment      ?? null,
  };
}

async function markStatus(
  supabase: SupabaseClient,
  userId:   string,
  status:   string,
  reason:   string | null,
  extra:    Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({
      identity_verification_status:     status,
      identity_verification_reason:     reason,
      identity_verification_updated_at: new Date().toISOString(),
      ...extra,
    })
    .eq('id', userId);
  if (error) {
    console.error('[didit-webhook] failed to write identity_verification_status', { userId, status, error: error.message });
  }
}

function faceMatchScore(event: DiditWebhookEvent): number | null {
  const score = event.decision?.face_matches?.[0]?.score;
  return typeof score === 'number' ? score : null;
}

// ── OCR fallback path — UNCHANGED behaviour from before the DHA path ──

async function handleApprovedOcr(supabase: SupabaseClient, userId: string, event: DiditWebhookEvent): Promise<void> {
  const cleanedId = event.decision?.id_verifications?.[0]?.personal_number?.replace(/\s+/g, '') ?? null;

  if (!cleanedId) {
    console.warn('[didit-webhook] Approved session carried no personal_number', { userId, sessionId: event.session_id });
    await markStatus(supabase, userId, 'declined', 'no_id_extracted', envelopeFields(event));
    return;
  }

  const check = validateSaId(cleanedId);
  if (!check.valid) {
    console.warn('[didit-webhook] extracted ID failed SA ID validation', { userId, sessionId: event.session_id, reason: check.reason });
    await markStatus(supabase, userId, 'declined', 'invalid_id', envelopeFields(event));
    return;
  }

  const age = saIdAge(cleanedId);
  if (age === null || age < 18) {
    console.warn('[didit-webhook] extracted ID indicates under-18', { userId, sessionId: event.session_id });
    await markStatus(supabase, userId, 'declined', 'underage', envelopeFields(event));
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
    console.error('[didit-webhook] ALERT SA ID duplicate check failed — could not verify your ID number just now (transient), retry expected', {
      userId, sessionId: event.session_id, error: err instanceof Error ? err.message : String(err),
    });
    throw new TransientDuplicateCheckError('OCR path duplicate-SA-ID lookup failed');
  }
  if (idOwner && idOwner.id !== userId) {
    console.warn(`[didit-webhook] ${DUPLICATE_ID_MESSAGE}`, { userId, ownerId: idOwner.id });
    await markStatus(supabase, userId, 'declined', 'id_already_registered', envelopeFields(event));
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
      ...envelopeFields(event),
    })
    .eq('id', userId);
  if (error) {
    console.error('[didit-webhook] ALERT failed to persist approved identity verification', { userId, error: error.message });
  }
}

// ── DHA path ──

// ─── AML screening: REMOVED, deliberately ──────────────────────────────
//
// Both paths used to call a standalone screenAml() before approving, and
// route to 'aml_hit_or_unavailable' on a hit OR on the call failing.
//
// Why it went: the /v3/aml/ endpoint it used was never confirmed against
// the live API (it came from a catalogue description while docs were
// unreachable). In production every call failed, and because the webhook
// collapsed any non-success into `amlUnavailable`, that meant 100% of
// otherwise-approved applicants were routed to review — a queue that is
// not staffed. Gating every approval on a call that always fails is worse
// than either screening properly or not screening at all.
//
// ── IF THIS NEEDS TO COME BACK ──────────────────────────────────────
// This was a deliberate product decision, not an oversight. AML and
// sanctions screening is a FICA obligation for accountable institutions
// in South Africa, and whether a credit provider falls in scope is a
// question for legal counsel rather than for this file. If the answer is
// yes, restoring this needs THREE things the previous version lacked:
//
//   1. A VERIFIED endpoint and response shape. The old code read
//      `status` and `total_hits`; if a 2xx arrived without them it would
//      have read as "no hits" — a silent false clear, which is worse
//      than no screening because it looks like screening.
//   2. A distinction between "hit" and "call failed". Collapsing them
//      made an outage indistinguishable from a sanctions match, and hid
//      the endpoint bug for the whole of its life.
//   3. A staffed review queue, since a real hit must reach a human.
//
// The 'aml_hit_or_unavailable' value is intentionally LEFT IN the reason
// CHECK constraint (migrations 0103-0105). Existing rows carry it, so
// removing it would fail the migration — and keeping it means a restored
// implementation needs no schema change.

async function handleApprovedDha(supabase: SupabaseClient, userId: string, event: DiditWebhookEvent): Promise<void> {
  const score = faceMatchScore(event);
  const approveMin = Number(process.env.DHA_FACE_MATCH_APPROVE_MIN ?? 70);
  const reviewMin  = Number(process.env.DHA_FACE_MATCH_REVIEW_MIN  ?? 45);

  const scoreFields = { dha_face_match_score: score, ...envelopeFields(event) };

  if (score === null) {
    console.warn('[didit-webhook] DHA path: Approved session carried no face_matches[0].score', { userId, sessionId: event.session_id });
    await markStatus(supabase, userId, 'declined', 'face_match_below_threshold', scoreFields);
    return;
  }
  if (score < reviewMin) {
    await markStatus(supabase, userId, 'declined', 'face_match_below_threshold', scoreFields);
    return;
  }
  if (score < approveMin) {
    // Ambiguous zone — a human decides. NEVER routed to the OCR
    // fallback: an impostor who deliberately fails the registry match
    // would otherwise reach the weaker document-scan check on purpose.
    await markStatus(supabase, userId, 'in_review', 'face_match_below_threshold', scoreFields);
    return;
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('pending_sa_id_number, pending_sa_id_lookup_hash, dha_first_name, dha_last_name')
    .eq('id', userId)
    .maybeSingle();

  const pendingEncrypted = profile?.pending_sa_id_number as string | null;
  const pendingHash      = profile?.pending_sa_id_lookup_hash as string | null;

  if (!pendingEncrypted || !pendingHash) {
    console.error('[didit-webhook] ALERT DHA session Approved but no pending_sa_id_number on file', { userId, sessionId: event.session_id });
    await markStatus(supabase, userId, 'declined', 'dha_unrecognised_outcome', scoreFields);
    return;
  }

  let plaintext: string;
  try {
    plaintext = decryptId(pendingEncrypted);
  } catch (err) {
    console.error('[didit-webhook] ALERT failed to decrypt pending_sa_id_number — approved session not persisted', {
      userId, error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Same invariant the OCR path enforces (see its comment above) — a
  // DHA-matched ID can still already belong to another account.
  let idOwner: Awaited<ReturnType<typeof findPatientBySaId>>;
  try {
    idOwner = await findPatientBySaId(supabase, plaintext);
  } catch (err) {
    console.error('[didit-webhook] ALERT SA ID duplicate check failed — could not verify your ID number just now (transient), retry expected', {
      userId, sessionId: event.session_id, error: err instanceof Error ? err.message : String(err),
    });
    throw new TransientDuplicateCheckError('DHA path duplicate-SA-ID lookup failed');
  }
  if (idOwner && idOwner.id !== userId) {
    console.warn(`[didit-webhook] ${DUPLICATE_ID_MESSAGE}`, { userId, ownerId: idOwner.id });
    await markStatus(supabase, userId, 'declined', 'id_already_registered', scoreFields);
    return;
  }

  const now = new Date().toISOString();

  const { error } = await supabase
    .from('profiles')
    .update({
      sa_id_number:                     pendingEncrypted, // already AES-256-GCM encrypted, same format as OCR path
      sa_id_lookup_hash:                pendingHash,
      liveness_verified_at:             now, // the DHA-registry face match IS this path's liveness ceremony
      identity_verification_status:     'approved',
      identity_verification_reason:     null,
      identity_verification_updated_at: now,
      pending_sa_id_number:             null,
      pending_sa_id_lookup_hash:        null,
      ...scoreFields,
    })
    .eq('id', userId);
  if (error) {
    console.error('[didit-webhook] ALERT failed to persist approved DHA identity verification', { userId, error: error.message });
  }
}

// ── Path resolution — stored column is authority, workflow_id is a cross-check only ──

type ResolvedPath = { path: 'ocr' | 'dha' } | { path: 'unresolved'; reason: string };

async function resolveVerificationPath(supabase: SupabaseClient, userId: string, event: DiditWebhookEvent): Promise<ResolvedPath> {
  const { data } = await supabase.from('profiles').select('identity_verification_path').eq('id', userId).maybeSingle();
  const stored = data?.identity_verification_path as 'dha' | 'ocr' | null | undefined;

  if (!stored) {
    return { path: 'unresolved', reason: 'no identity_verification_path stored for this profile' };
  }

  const expectedWorkflowId = stored === 'dha' ? process.env.DIDIT_DHA_WORKFLOW_ID : process.env.DIDIT_WORKFLOW_ID;
  if (expectedWorkflowId && event.workflow_id && event.workflow_id !== expectedWorkflowId) {
    return {
      path: 'unresolved',
      reason: `stored path '${stored}' expects workflow_id '${expectedWorkflowId}' but envelope carries '${event.workflow_id}'`,
    };
  }

  return { path: stored };
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
    // A 4xx other than 404 is never retried by Didit's delivery policy —
    // deliberate here: an unauthenticated delivery should NOT be retried
    // as though it were a transient failure.
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

    const resolved = await resolveVerificationPath(supabase, userId, parsed);
    if (resolved.path === 'unresolved') {
      console.error('[didit-webhook] ALERT could not resolve identity_verification_path — routing to review', {
        userId, sessionId: parsed.session_id, reason: resolved.reason,
      });
      await markStatus(supabase, userId, 'in_review', 'workflow_path_mismatch', envelopeFields(parsed));
      return NextResponse.json({ received: true }, { status: 200 });
    }

    try {
      if (parsed.status === 'Approved') {
        if (resolved.path === 'dha') {
          await handleApprovedDha(supabase, userId, parsed);
        } else {
          await handleApprovedOcr(supabase, userId, parsed);
        }
      } else {
        const mapped = TERMINAL_STATUS[parsed.status];
        if (mapped) {
          const extra = resolved.path === 'dha'
            ? { dha_face_match_score: faceMatchScore(parsed), ...envelopeFields(parsed) }
            : envelopeFields(parsed);
          await markStatus(supabase, userId, mapped, null, extra);
        }
        // Not Started / In Progress / Awaiting User / Resubmitted —
        // nothing to persist; the user is mid-flow.
      }
    } catch (err) {
      if (err instanceof TransientDuplicateCheckError) {
        // The ONE deliberate non-2xx for a handler-thrown error — this
        // is transient by construction (see the class comment), so
        // Didit's retry (5xx IS retried) is exactly the right response.
        //
        // Release the idempotency claim first, or the retry we are asking
        // for arrives, sees the row this delivery wrote on its way in, and
        // is answered as a duplicate — see releaseEventClaim (audit F-13).
        if (parsed.event_id) await releaseEventClaim(supabase, parsed.event_id);
        return NextResponse.json({ error: 'Temporary failure, please retry' }, { status: 500 });
      }
      console.error('[didit-webhook] ALERT handler threw', {
        userId, sessionId: parsed.session_id, status: parsed.status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
