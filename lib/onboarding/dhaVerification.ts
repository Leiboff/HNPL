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
  | 'dha_id_mismatch';

export type IdentityReviewReason =
  | 'dha_unrecognised_outcome'
  | 'dha_not_on_register';

export type RouteDecision =
  | {
      kind:          'dha';
      photoBase64:   string;
      dhaFirstName?: string;
      dhaLastName?:  string;
      requestId?:    string;
      outcomeCode:   string;
    }
  | { kind: 'ocr_fallback'; reason: string }
  | { kind: 'reject';       reason: IdentityRejectReason }
  | { kind: 'review';       reason: IdentityReviewReason }
  // Our own request was malformed/rejected (non-timeout, non-5xx 4xx).
  // Deliberately NOT 'reject' (that implies the applicant's identity
  // failed a check) and NOT 'review' (implies a human should look at
  // THEM). This is an integration bug — no identity_verification_status
  // write happens for it; the caller logs an ALERT and tells the
  // patient verification is temporarily unavailable.
  | { kind: 'error'; status: number; detail: string };

/** Recognises explicit true/false in whatever shape DHA sends it (boolean or string). Never treats presence-but-unparsable as false. */
function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number')  return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }
  return false;
}

function isFalsyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value === false;
  if (typeof value === 'number')  return value === 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'false' || v === '0' || v === 'no';
  }
  return false;
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
    return { kind: 'ocr_fallback', reason: 'registry_unavailable' };
  }
  if (outcome.kind === 'request_error') {
    // Our own request was rejected — an integration bug, not a
    // registry-availability signal. Never falls back, never approves.
    return { kind: 'error', status: outcome.status, detail: outcome.detail };
  }

  // outcome.kind === 'success'
  const row = outcome.data.validations?.find((v) => v.service_id === 'zaf_dha_photo');
  if (!row || !row.outcome_code) {
    return { kind: 'review', reason: 'dha_unrecognised_outcome' };
  }

  switch (row.outcome_code) {
    case 'NO_MATCH':
      return { kind: 'reject', reason: 'dha_no_match' };

    case 'DOCUMENT_NOT_FOUND':
      return { kind: 'reject', reason: 'dha_document_not_found' };

    case 'REGISTRY_UNAVAILABLE':
      return { kind: 'ocr_fallback', reason: 'registry_unavailable' };

    case 'BIOMETRIC_IMAGE_UNUSABLE':
      return { kind: 'ocr_fallback', reason: 'biometric_image_unusable' };

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

      if (sd.id_blocked == null) return { kind: 'review', reason: 'dha_unrecognised_outcome' };
      if (isTruthyFlag(sd.id_blocked)) return { kind: 'reject', reason: 'dha_id_blocked' };

      if (sd.deceased == null) return { kind: 'review', reason: 'dha_unrecognised_outcome' };
      if (isTruthyFlag(sd.deceased)) return { kind: 'reject', reason: 'dha_deceased' };

      // Falsy OR absent both route to review — same handling either way.
      if (sd.on_national_population_register == null || isFalsyFlag(sd.on_national_population_register)) {
        return { kind: 'review', reason: 'dha_not_on_register' };
      }

      if (!sd.photo_base64) {
        // MATCH, identity confirmed, nothing disqualifying — but no
        // usable photo to face-match against. Per the routing table
        // this is the SAME bucket as BIOMETRIC_IMAGE_UNUSABLE, not a
        // decline: the person is real and on the register, we just
        // can't run the biometric check against them right now.
        return { kind: 'ocr_fallback', reason: 'biometric_image_unusable' };
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
