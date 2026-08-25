// ─── DHA routing table (pure decision logic) ────────────────────────────
//
// Turns a DHA database-validation outcome into ONE of four routes. The
// single most important property of this module: the OCR fallback
// triggers ONLY on the DHA *service* failing to answer — never on the
// service answering "this identity is not in the register". Conflating
// those two would let a fabricated ID number route around the registry
// check into the weaker document path. Every branch below is written
// against that invariant explicitly, not as an `if (!photo) fallback`
// shortcut — see the adversarial test cases in dhaVerification.test.ts.
//
// Every DHA-sourced signal is treated as absent-by-default: a MISSING
// field never gets the safe/permissive interpretation. The one
// deliberate exception is documented inline (identification_number).

import { callDhaPhotoLookup, type DhaLookupOutcome } from '@/lib/didit/dha';

export type IdentityRejectReason =
  | 'dha_no_match'
  | 'dha_document_not_found'
  | 'dha_deceased'
  | 'dha_id_blocked'
  | 'dha_id_mismatch'
  // ── Datanamix (bureau-sourced) equivalents. Deliberately NOT reusing
  // the dha_* values: those assert "Home Affairs said so", while these
  // mean "a credit bureau's copy of Home Affairs data, up to ~30 days
  // stale, said so". In a lending dispute that distinction is the whole
  // question, so the audit trail records which source made each call.
  // See lib/onboarding/datanamixVerification.ts.
  | 'dnx_no_match'
  | 'dnx_not_found'
  | 'dnx_deceased'
  | 'dnx_id_blocked'
  | 'dnx_id_mismatch'
  // Shared, source-agnostic — both providers can produce these.
  | 'invalid_id'
  | 'underage';

export type IdentityReviewReason =
  | 'dha_unrecognised_outcome'
  | 'dha_not_on_register'
  | 'dnx_unrecognised_outcome'
  | 'dnx_hanis_not_matched'
  // ── Formerly routed to an OCR document-scan fallback, now reviewed.
  //
  // Both describe a LEGITIMATE applicant we could not biometrically
  // verify right now — the registry did not refuse them, it failed to
  // answer or returned no usable portrait. Declining them would punish
  // someone for a vendor outage, so they go to a human.
  //
  // The OCR path they used to fall back to has been removed: it verified
  // a selfie against a photograph of a plastic card, which is forgeable,
  // so it was strictly weaker evidence than the registry path it was
  // standing in for. Silently downgrading to weaker evidence on a vendor
  // timeout is not a safe default for a lender.
  //
  // OPERATIONAL CONSEQUENCE: a registry outage now sends every applicant
  // to the review queue instead of quietly completing via OCR. That
  // queue must be staffed for this to be an acceptable trade.
  | 'registry_unavailable'
  | 'biometric_image_unusable';

export type RouteDecision =
  | {
      kind:          'dha';
      photoBase64:   string;
      dhaFirstName?: string;
      dhaLastName?:  string;
      requestId?:    string;
      outcomeCode:   string;
      // ── Source provenance. Populated by the Datanamix path only; the
      // Didit path is a live registry query with no lag to declare, so
      // both stay undefined there (persisted as NULL — see migration
      // 0104). Recorded so a decision made against a stale bureau copy
      // is auditable AS SUCH rather than indistinguishable from a live
      // one. Observed live: offline true, "Less than 90 days".
      sourceOffline?:     boolean;
      sourceLastUpdated?: string;
    }
  | { kind: 'reject';       reason: IdentityRejectReason }
  | { kind: 'review';       reason: IdentityReviewReason }
  // Our own request was malformed/rejected (non-timeout, non-5xx 4xx).
  // Deliberately NOT 'reject' (that implies the applicant's identity
  // failed a check) and NOT 'review' (implies a human should look at
  // THEM). This is an integration bug — no identity_verification_status
  // write happens for it; the caller logs an ALERT and tells the
  // patient verification is temporarily unavailable.
  | { kind: 'error'; status: number; detail: string };

/**
 * Three-valued flag parser. Recognises explicit true/false in whatever
 * shape DHA sends it (boolean, number, or string) and returns 'unknown'
 * for anything present but unrecognised.
 *
 * The third value is the whole point. DHA's flag VOCABULARY is unverified
 * (see lib/didit/dha.ts) — Didit's own sample response types `deceased`
 * as a string, so 'Y'/'N' is entirely plausible. A two-valued parser has
 * to pick a default for unrecognised input, and any default is wrong:
 * defaulting false means a deceased or blocked ID quietly passes;
 * defaulting true means live applicants get rejected. Returning 'unknown'
 * lets each call site route to review, which is the only honest answer to
 * "the registry said something we don't understand".
 *
 * Deliberately does NOT accept 'y'/'n' as true/false. We don't know that
 * DHA uses them, and guessing a vocabulary is the exact failure this
 * function exists to prevent — an unrecognised value must reach a human,
 * not be interpreted. If 'Y'/'N' is confirmed against the live API, add
 * it here explicitly and delete this paragraph.
 */
function parseFlag(value: unknown): boolean | 'unknown' {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'unknown';
    return value !== 0;
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true'  || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no')  return false;
    return 'unknown';
  }
  return 'unknown';
}

function normalizeId(id: string): string {
  return id.replace(/\s+/g, '');
}

/**
 * Pure — given a DHA lookup outcome (and the ID we actually submitted),
 * decide the route. No I/O. This is the function the 22 required test
 * cases are written against directly; resolveIdentityRoute below is a
 * thin async wrapper that calls the real API and delegates here.
 */
export function routeFromDhaOutcome(outcome: DhaLookupOutcome, submittedNationalId: string): RouteDecision {
  // ── Transport layer — see lib/didit/dha.ts for the full reasoning ──
  if (outcome.kind === 'unavailable') {
    return { kind: 'review', reason: 'registry_unavailable' };
  }
  if (outcome.kind === 'request_error') {
    // Our own request was rejected — an integration bug, not a
    // registry-availability signal. Never falls back, never approves.
    return { kind: 'error', status: outcome.status, detail: outcome.detail };
  }

  // outcome.kind === 'success'
  // VERIFIED live 2026-08-24: validations[] is nested under
  // `database_validation`, NOT at the top level. request_id is the
  // exception — it stays top-level. The sandbox environment returns a
  // different shape entirely (validations as an object, no source_data,
  // no photo), so this must be checked against live, never sandbox.
  const row = outcome.data.database_validation?.validations?.find(
    (v) => v.service_id === 'zaf_dha_photo',
  );
  if (!row || !row.outcome_code) {
    return { kind: 'review', reason: 'dha_unrecognised_outcome' };
  }

  switch (row.outcome_code) {
    case 'NO_MATCH':
      return { kind: 'reject', reason: 'dha_no_match' };

    case 'DOCUMENT_NOT_FOUND':
      return { kind: 'reject', reason: 'dha_document_not_found' };

    case 'REGISTRY_UNAVAILABLE':
      return { kind: 'review', reason: 'registry_unavailable' };

    case 'BIOMETRIC_IMAGE_UNUSABLE':
      return { kind: 'review', reason: 'biometric_image_unusable' };

    case 'MATCH': {
      const sd = row.source_data ?? {};

      // ── Identity binding first: everything else we read below is
      // only trustworthy if the registry actually matched OUR id. ──
      // Deliberate exception to absent-by-default: an ABSENT echoed id
      // is treated the same as a MISMATCHED one (reject), not review —
      // per explicit instruction, "loud rather than tolerant".
      const echoed = sd.identification_number;
      if (!echoed || normalizeId(echoed) !== normalizeId(submittedNationalId)) {
        return { kind: 'reject', reason: 'dha_id_mismatch' };
      }

      // Absent OR unrecognised both route to review — we must never
      // infer "not blocked" / "not deceased" from a value we can't read.
      if (sd.id_blocked == null) return { kind: 'review', reason: 'dha_unrecognised_outcome' };
      const idBlocked = parseFlag(sd.id_blocked);
      if (idBlocked === 'unknown') return { kind: 'review', reason: 'dha_unrecognised_outcome' };
      if (idBlocked) return { kind: 'reject', reason: 'dha_id_blocked' };

      if (sd.deceased == null) return { kind: 'review', reason: 'dha_unrecognised_outcome' };
      const deceased = parseFlag(sd.deceased);
      if (deceased === 'unknown') return { kind: 'review', reason: 'dha_unrecognised_outcome' };
      if (deceased) return { kind: 'reject', reason: 'dha_deceased' };

      // Absent, explicitly false, and unrecognised all route to review.
      // The reason differs only so the queue can tell "registry says not
      // on the register" apart from "registry said something unreadable".
      if (sd.on_national_population_register == null) {
        return { kind: 'review', reason: 'dha_not_on_register' };
      }
      const onRegister = parseFlag(sd.on_national_population_register);
      if (onRegister === 'unknown') return { kind: 'review', reason: 'dha_unrecognised_outcome' };
      if (!onRegister) return { kind: 'review', reason: 'dha_not_on_register' };

      if (!sd.photo_base64) {
        // MATCH, identity confirmed, nothing disqualifying — but no
        // usable photo to face-match against. Per the routing table
        // this is the SAME bucket as BIOMETRIC_IMAGE_UNUSABLE, not a
        // decline: the person is real and on the register, we just
        // can't run the biometric check against them right now.
        return { kind: 'review', reason: 'biometric_image_unusable' };
      }

      return {
        kind:         'dha',
        photoBase64:  sd.photo_base64,
        dhaFirstName: sd.first_name,
        dhaLastName:  sd.last_name,
        requestId:    outcome.data.request_id,
        outcomeCode:  row.outcome_code,
      };
    }

    default:
      // Any outcome_code we don't recognise. The list is not documented
      // as exhaustive — review, never fallback, never approve.
      return { kind: 'review', reason: 'dha_unrecognised_outcome' };
  }
}

export async function resolveIdentityRoute(nationalId: string, vendorData: string): Promise<RouteDecision> {
  const outcome = await callDhaPhotoLookup({ nationalId, vendorData });
  return routeFromDhaOutcome(outcome, nationalId);
}
