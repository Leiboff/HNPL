// ─── Datanamix routing table (pure decision logic) ──────────────────────
//
// The bureau-sourced counterpart to dhaVerification.ts, producing the
// SAME RouteDecision so that createDhaFaceMatchSession, the webhook, and
// every downstream consumer stay untouched.
//
// The core invariant is identical and non-negotiable: the OCR fallback
// triggers ONLY on the registry failing to answer — never on it
// answering "this identity is not in the register". A no-match DECLINES.
//
// Three things differ from the DHA path, all of them load-bearing:
//
//   1. VOCABULARY. Datanamix speaks in string enums, not booleans:
//      DeceasedStatus "Alive", IDNumberBlocked "NO", HasImage "True",
//      HanisIDMatch "Matched". parseFlag() handles "NO"/"True" by luck
//      but returns 'unknown' for "Alive" and "Matched", so those need
//      explicit mappers below. Every mapper is three-valued for the
//      same reason parseFlag is — an unrecognised value must reach a
//      human, never be interpreted.
//
//   2. STALENESS. This is a credit-bureau copy of Home Affairs data, not
//      a live query. Observed OfflineIndicator "Yes" / LastUpdated
//      "Less than 30 days" means a DeceasedStatus or IDNumberBlocked
//      value may lag the real register by up to a month. We cannot close
//      that gap in code; we record it (see the staleness fields on the
//      'dha' decision) so it is auditable per-decision.
//
//   3. PHOTO SIZE. ~1.9MB versus Didit's ~40KB, so the portrait is
//      downscaled before it can be handed to a Didit session.

import {
  callDatanamixProfilePlus,
  type DatanamixLookupOutcome,
} from '@/lib/datanamix/client';
import { downscalePortrait } from '@/lib/datanamix/portrait';
import type { RouteDecision } from './dhaVerification';

/** Three-valued, like parseFlag — 'unknown' must reach a human. */
function mapDeceasedStatus(value: string | undefined): boolean | 'unknown' {
  if (value == null) return 'unknown';
  const v = value.trim().toLowerCase();
  if (v === 'alive')    return false;
  if (v === 'deceased') return true;
  return 'unknown';
}

/** Datanamix sends UPPERCASE "NO"/"YES"; lowercase before comparing. */
function mapBlockedStatus(value: string | undefined): boolean | 'unknown' {
  if (value == null) return 'unknown';
  const v = value.trim().toLowerCase();
  if (v === 'no'  || v === 'false') return false;
  if (v === 'yes' || v === 'true')  return true;
  return 'unknown';
}

/** "Matched" / "Not Matched" style fields. */
function mapMatchStatus(value: string | undefined): boolean | 'unknown' {
  if (value == null) return 'unknown';
  const v = value.trim().toLowerCase();
  if (v === 'matched')                            return true;
  if (v === 'not matched' || v === 'notmatched')  return false;
  return 'unknown';
}

function mapHasImage(value: string | undefined): boolean | 'unknown' {
  if (value == null) return 'unknown';
  const v = value.trim().toLowerCase();
  if (v === 'true'  || v === 'yes') return true;
  if (v === 'false' || v === 'no')  return false;
  return 'unknown';
}

function normalizeId(id: string): string {
  return id.replace(/\s+/g, '');
}

/**
 * Pure — decides the route from a Datanamix outcome, EXCEPT that a
 * successful decision still needs its portrait downscaled (async). This
 * returns the decision with the RAW portrait; resolveDatanamixRoute
 * below performs the downscale. Split this way so the entire decision
 * table stays synchronous and directly testable, exactly as
 * routeFromDhaOutcome is.
 */
export function routeFromDatanamixOutcome(
  outcome: DatanamixLookupOutcome,
  submittedNationalId: string,
): RouteDecision {
  // ── Transport layer ──
  if (outcome.kind === 'unavailable') {
    return { kind: 'ocr_fallback', reason: 'registry_unavailable' };
  }
  if (outcome.kind === 'request_error') {
    return { kind: 'error', status: outcome.status, detail: outcome.detail };
  }

  const { data } = outcome;

  // ── Envelope: branch on ResponseCode ONLY, never HTTP status. Their
  // documented 404 covers both "product not activated on your account"
  // and ResponseCode 4 "no record found" — routing on status would
  // reject every applicant the moment the product was switched off. ──
  switch (data.ResponseCode) {
    case 0:
      break; // fall through to the field checks

    case 4:
      // No bureau record for this ID. An answer, not an outage — so it
      // declines rather than falling back, per the core invariant.
      return { kind: 'reject', reason: 'dnx_not_found' };

    case 5:
      return { kind: 'ocr_fallback', reason: 'registry_unavailable' };

    case 6:
      // Validation error on the SUBMITTED ID — a decline, not an
      // integration bug. This is the one place Datanamix's semantics
      // diverge from Didit's, where a 4xx always meant our own bug.
      return { kind: 'reject', reason: 'invalid_id' };

    case 7:
      return { kind: 'ocr_fallback', reason: 'registry_unavailable' };

    case 8:
      // Minor. submitIdentityForVerification already blocks under-18s
      // before any lookup, so reaching here means our own age check and
      // the bureau's disagree — decline and let the mismatch surface.
      return { kind: 'reject', reason: 'underage' };

    case 403:
      // Bad or expired credentials — our problem, not the applicant's.
      return { kind: 'error', status: 403, detail: 'datanamix_forbidden' };

    default:
      // Undocumented code. Review, never fall back, never approve.
      return { kind: 'review', reason: 'dnx_unrecognised_outcome' };
  }

  const idv = data.Result?.IDVerificationResults;
  const bio = data.Result?.BiometricVerificationResults;

  if (!idv) return { kind: 'review', reason: 'dnx_unrecognised_outcome' };

  // ── Identity binding first: nothing below is trustworthy unless the
  // bureau matched the ID we actually submitted. Absent is treated the
  // same as mismatched (reject, not review) — loud rather than
  // tolerant, matching the DHA path's deliberate exception. ──
  const echoed = idv.IDNumber;
  if (!echoed || normalizeId(echoed) !== normalizeId(submittedNationalId)) {
    return { kind: 'reject', reason: 'dnx_id_mismatch' };
  }

  const idMatched = mapMatchStatus(idv.IDNumberMatchStatus);
  if (idMatched === 'unknown') return { kind: 'review', reason: 'dnx_unrecognised_outcome' };
  if (!idMatched)              return { kind: 'reject', reason: 'dnx_no_match' };

  // ── Disqualifying flags. Absent OR unrecognised both route to review:
  // we must never infer "not blocked"/"not deceased" from a value we
  // cannot read. ──
  const blocked = mapBlockedStatus(idv.IDNumberBlocked);
  if (blocked === 'unknown') return { kind: 'review', reason: 'dnx_unrecognised_outcome' };
  if (blocked)               return { kind: 'reject', reason: 'dnx_id_blocked' };

  const deceased = mapDeceasedStatus(idv.DeceasedStatus);
  if (deceased === 'unknown') return { kind: 'review', reason: 'dnx_unrecognised_outcome' };
  if (deceased)               return { kind: 'reject', reason: 'dnx_deceased' };

  // ── HANIS binding. The nearest analogue to the DHA path's
  // on_national_population_register: it asserts the portrait genuinely
  // came from the HANIS biometric register rather than some other
  // source. Without it we would be face-matching against an image of
  // unknown provenance, so a non-match is NOT approvable. ──
  const hanis = mapMatchStatus(bio?.HanisIDMatch);
  if (hanis === 'unknown') return { kind: 'review', reason: 'dnx_unrecognised_outcome' };
  if (!hanis)              return { kind: 'review', reason: 'dnx_hanis_not_matched' };

  const hasImage = mapHasImage(bio?.HasImage);
  if (hasImage === 'unknown') return { kind: 'review', reason: 'dnx_unrecognised_outcome' };

  if (!hasImage || !bio?.ImageBase64) {
    // Identity confirmed, nothing disqualifying, but no usable portrait
    // to face-match against. Same bucket as the DHA path's
    // BIOMETRIC_IMAGE_UNUSABLE — not a decline. The person is real; we
    // just cannot run the biometric check on them right now.
    return { kind: 'ocr_fallback', reason: 'biometric_image_unusable' };
  }

  return {
    kind:         'dha',
    photoBase64:  bio.ImageBase64, // downscaled by resolveDatanamixRoute
    dhaFirstName: idv.Names,
    dhaLastName:  idv.Surname,
    requestId:    data.Header?.ReportReference,
    outcomeCode:  'DNX_MATCH',
    // What the bureau itself declared about its own currency, verbatim.
    // OfflineIndicator "Yes" means served from the bureau copy rather
    // than a live DHA query. Anything unrecognised becomes undefined
    // rather than a guessed boolean — an unreadable provenance claim is
    // recorded as unknown, not as "live".
    sourceOffline:     mapHasImage(idv.OfflineIndicator) === 'unknown'
                         ? undefined
                         : mapHasImage(idv.OfflineIndicator) as boolean,
    sourceLastUpdated: idv.LastUpdated?.trim() || undefined,
  };
}

/**
 * Async wrapper: performs the lookup, routes it, and — on the approve
 * branch — downscales the ~1.9MB bureau portrait to something a Didit
 * session will accept.
 *
 * Signature-compatible with resolveIdentityRoute in dhaVerification.ts,
 * so callers can be switched between providers without other changes.
 */
export async function resolveDatanamixRoute(
  nationalId: string,
  vendorData: string,
): Promise<RouteDecision> {
  const outcome = await callDatanamixProfilePlus({ nationalId, vendorData });
  const route = routeFromDatanamixOutcome(outcome, nationalId);

  if (route.kind !== 'dha') return route;

  const shrunk = await downscalePortrait(route.photoBase64);
  if (!shrunk) {
    // Undecodable image. NOT an approval on the original oversized
    // buffer — that would only fail later inside
    // createDhaFaceMatchSession's size guard, where the cause is far
    // harder to diagnose.
    return { kind: 'ocr_fallback', reason: 'biometric_image_unusable' };
  }

  return { ...route, photoBase64: shrunk.base64 };
}
