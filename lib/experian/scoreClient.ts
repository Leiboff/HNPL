// SERVER-ONLY. Never import in a client component.
//
// ─── Experian GetPersonScore (`getScore`) ───────────────────────────────
//
// The cheap gate. Runs before the paid identity checks and before the paid
// affordability enquiry, so that a below-average-risk applicant costs us
// one call rather than three.
//
// ─── THE WIRE FORMAT, VERIFIED AGAINST A LIVE CALL ─────────────────────
//
// The published PDF is wrong or stale in several places, so this is built
// from a captured UAT request/response pair. Where they disagree, the
// capture wins.
//
//   • The URL path is /GetPersonScore but the OPERATION is `getScore`.
//   • Namespace is http://services/ — NOT http://webServices/, which is
//     the affordability service. Different deployment.
//   • Parameters are FLAT children of the operation. There is no <request>
//     wrapper; that is the affordability service's shape and sending it
//     here does not bind (-101).
//   • Element names are pUsername, pPassword, pMyOrigin, pVersion,
//     pResultType, pIdNumber. Note pMyOrigin (not pOrigin), pVersion (not
//     pRequestVersion) and pResultType (not pOutputFormat) — all three
//     differ from the affordability call.
//   • The reply is a <TransactionReplyClass> carrying errorCode,
//     errorDescription, returnData and transactionCompleted. Note
//     errorDescription and returnData — the affordability service uses
//     errorString and retData for the same two fields.
//   • errorCode is the EMPTY STRING on success, not "0".
//   • The spec documents a `hasErrors` field. The live SOAP reply does not
//     contain it, so nothing here depends on it.
//
// ─── NO ENQUIRY-TYPE PARAMETER EXISTS ──────────────────────────────────
//
// `getScore` takes the six parameters above and nothing else. Whether this
// enquiry lands as soft or hard is an account-level setting at Experian,
// not something we can pass. See the note in config.ts — it matters,
// because this call happens before identity verification.

import {
  experianCredentials,
  experianEndpoints,
  experianOrigin,
  scoreFamily,
  experianEnquiryType,
  SCORE_TIMEOUT_MS,
} from './config';
import { postSoap, xmlEscape, extractTag, extractFaultString, isSoapFault } from './soap';
import { redactEnvelope, maskIdsInText } from './redact';

const SCORE_NAMESPACE = 'http://services/';

export type ScoreReason = { reasonCode: string; reasonDescription: string };

export type ScoreResultRow = {
  resultType: string;
  score: string;
  reasons: ScoreReason[];
};

// ── Error codes (spec §9) ─────────────────────────────────────────────
//
// This table belongs to `getScore` ALONE. The affordability service has a
// completely different set (-201/-204/-205/-207/-209/-217) and sharing one
// mapping between them would mis-read both.
//
// `disposition` is what we DO, and the only value that is ever visible to
// an applicant as an outcome is 'thin_file'. Everything else resolves to
// pending: a bureau we could not get an answer from is not a refusal.

export type ScoreErrorDisposition =
  /** Answered, no data. A grant at the thin-file ceiling. */
  | 'thin_file'
  /** Transient. Retry once, then pending. */
  | 'retry'
  /** Our configuration or our XML is wrong. Pending + alert loudly. */
  | 'alert';

type ScoreErrorSpec = { disposition: ScoreErrorDisposition; meaning: string };

export const SCORE_ERROR_CODES: Readonly<Record<string, ScoreErrorSpec>> = {
  '-101': { disposition: 'alert',     meaning: 'Not all variables filled in — our envelope is wrong' },
  '-105': { disposition: 'alert',     meaning: 'Input version not supported — check EXPERIAN_SCORE_VERSION' },
  '-106': { disposition: 'retry',     meaning: 'Server-side failure during execution' },
  '-107': { disposition: 'alert',     meaning: 'Invalid credentials or user inactive' },
  '-108': { disposition: 'alert',     meaning: 'Result type not supported' },
  '-110': { disposition: 'alert',     meaning: 'Branch not switched on for this service' },
  '-113': { disposition: 'alert',     meaning: 'ID number not supplied — our envelope is wrong' },
  '-114': { disposition: 'alert',     meaning: 'Invalid ID number — should be unreachable, we validate first' },
  '-115': { disposition: 'thin_file', meaning: 'Thin file — no data available for this ID' },
  '-116': { disposition: 'alert',     meaning: 'Branch not switched on for any CompuScore version' },
  '-999': { disposition: 'retry',     meaning: 'Unknown error' },
} as const;

export function dispositionFor(code: string): ScoreErrorSpec {
  return SCORE_ERROR_CODES[code.trim()]
    // An undocumented code is not a decline. We do not refuse an applicant
    // on an answer we cannot read.
    ?? { disposition: 'alert', meaning: `Undocumented error code ${code}` };
}

export type ScoreCallOutcome =
  /** A parsed reply carrying at least one scorecard result. */
  | { kind: 'results'; idNumber: string; results: ScoreResultRow[] }
  /** The bureau answered with a coded error. */
  | { kind: 'error_code'; code: string; description: string; disposition: ScoreErrorDisposition; meaning: string }
  /** Timeout, transport failure, SOAP fault, or a reply we could not parse. */
  | { kind: 'unavailable'; detail: string };

/**
 * Build the request envelope.
 *
 * Every interpolated value is XML-escaped. A password containing `&` would
 * otherwise produce malformed XML and a -101 that looks like a schema bug.
 *
 * Element ORDER follows the captured request. The affordability service's
 * schema is an xs:sequence where order is load-bearing; this one is not
 * known to be, but matching the capture costs nothing and removes a
 * variable.
 */
export function buildGetScoreEnvelope(params: {
  username: string;
  password: string;
  origin: string;
  version: string;
  resultType: string;
  idNumber: string;
  enquiryType?: string | null;
}): string {
  // Omitted entirely when unset — an element the schema does not expect is
  // exactly how -101 happens.
  const enquiry = params.enquiryType
    ? `\n      <pEnquiryType>${xmlEscape(params.enquiryType)}</pEnquiryType>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/">
  <S:Body>
    <ns:getScore xmlns:ns="${SCORE_NAMESPACE}">
      <pUsername>${xmlEscape(params.username)}</pUsername>
      <pPassword>${xmlEscape(params.password)}</pPassword>
      <pMyOrigin>${xmlEscape(params.origin)}</pMyOrigin>
      <pVersion>${xmlEscape(params.version)}</pVersion>
      <pResultType>${xmlEscape(params.resultType)}</pResultType>
      <pIdNumber>${xmlEscape(params.idNumber)}</pIdNumber>${enquiry}
    </ns:getScore>
  </S:Body>
</S:Envelope>`;
}

/**
 * Parse a reply body into an outcome.
 *
 * Exported so the fixture tests exercise exactly the function the live
 * path uses, rather than a re-implementation.
 */
export function parseGetScoreResponse(xml: string): ScoreCallOutcome {
  if (isSoapFault(xml)) {
    const fault = extractFaultString(xml) ?? 'unknown fault';
    return { kind: 'unavailable', detail: `SOAP fault: ${maskIdsInText(fault)}` };
  }

  const errorCode = extractTag(xml, 'errorCode');
  const completed = extractTag(xml, 'transactionCompleted');

  // A coded error. Note the empty-string-on-success convention: an empty
  // errorCode is the NORMAL case and must not be treated as a failure.
  if (errorCode !== null && errorCode.trim() !== '') {
    const code = errorCode.trim();
    const spec = dispositionFor(code);
    return {
      kind: 'error_code',
      code,
      description: maskIdsInText(extractTag(xml, 'errorDescription') ?? ''),
      disposition: spec.disposition,
      meaning: spec.meaning,
    };
  }

  const returnData = extractTag(xml, 'returnData');
  if (returnData === null || returnData.trim() === '') {
    // transactionCompleted=false with no code, or a reply shaped in a way
    // we do not recognise. Unavailable, not a decline.
    return {
      kind: 'unavailable',
      detail: `no returnData (transactionCompleted=${completed ?? 'absent'})`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(returnData);
    // The affordability service double-encodes its payload and the spec
    // warns REST replies may too. Parse again if the first pass yields a
    // string rather than an object.
    if (typeof payload === 'string') payload = JSON.parse(payload);
  } catch {
    return { kind: 'unavailable', detail: 'returnData was not parseable JSON' };
  }

  const obj = payload as { idNumber?: unknown; results?: unknown };
  if (!Array.isArray(obj.results)) {
    return { kind: 'unavailable', detail: 'returnData carried no results array' };
  }

  const results: ScoreResultRow[] = obj.results
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => ({
      resultType: String(r.resultType ?? ''),
      score:      String(r.score ?? ''),
      reasons: Array.isArray(r.reasons)
        ? (r.reasons as Array<Record<string, unknown>>).map((x) => ({
            reasonCode:        String(x?.reasonCode ?? ''),
            reasonDescription: String(x?.reasonDescription ?? ''),
          }))
        : [],
    }));

  if (results.length === 0) {
    return { kind: 'unavailable', detail: 'returnData results array was empty' };
  }

  return { kind: 'results', idNumber: String(obj.idNumber ?? ''), results };
}

/**
 * Call the bureau for a person score.
 *
 * `idNumber` MUST already be checksum-validated — a -114 is a billable
 * enquiry spent on an answer we could have worked out for free.
 *
 * Retries exactly once, and only for a transient disposition or a
 * transport failure. A second failure resolves to pending; there is no
 * unbounded loop against a bureau that is having a bad afternoon.
 */
export async function getPersonScore(
  idNumber: string,
  opts: { retryOnce?: boolean } = {},
): Promise<ScoreCallOutcome> {
  const retryOnce = opts.retryOnce ?? true;
  const creds     = experianCredentials();
  const family    = scoreFamily();
  const url       = experianEndpoints().score;

  const envelope = buildGetScoreEnvelope({
    username:    creds.username,
    password:    creds.password,
    origin:      experianOrigin(),
    version:     family.pVersion,
    resultType:  'json',
    idNumber,
    enquiryType: experianEnquiryType(),
  });

  async function attempt(): Promise<ScoreCallOutcome> {
    const res = await postSoap(url, envelope, SCORE_TIMEOUT_MS);

    if (res.kind === 'unavailable') {
      console.error('[experian:score] transport failure', { detail: res.detail });
      return { kind: 'unavailable', detail: res.detail };
    }

    const outcome = parseGetScoreResponse(res.xml);

    if (outcome.kind === 'unavailable' && res.status >= 400) {
      // A fault or an error page. Log the REDACTED request so the shape is
      // diagnosable without publishing the password.
      console.error('[experian:score] error response', {
        status: res.status,
        detail: outcome.detail,
        request: redactEnvelope(envelope),
      });
    }

    if (outcome.kind === 'error_code' && outcome.disposition === 'alert') {
      console.error('[experian:score] ALERT bureau refused the request', {
        code: outcome.code,
        meaning: outcome.meaning,
        description: outcome.description,
        request: redactEnvelope(envelope),
      });
    }

    return outcome;
  }

  const first = await attempt();

  const transient =
    first.kind === 'unavailable'
    || (first.kind === 'error_code' && first.disposition === 'retry');

  if (!transient || !retryOnce) return first;

  return attempt();
}
