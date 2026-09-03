// SERVER-ONLY. Never import in a client component.
//
// ─── Experian DoAffordability ───────────────────────────────────────────
//
// Step 4 of the pipeline. Billable, and reached ONLY after the score gate
// has passed and identity verification has succeeded. Nothing in this
// module enforces that ordering — the pipeline does — but it is why this
// file exists separately from the score client rather than beside it in
// one "Experian client" that could be called in either order.
//
// ─── A DIFFERENT SERVICE, NOT A SECOND METHOD ──────────────────────────
//
// Everything differs from `getScore`:
//
//   • namespace http://webServices/ — NOT http://services/
//   • operation DoAffordability, capitalised
//   • ALL parameters wrapped in a single <request> element of type
//     AffordRequestParamsType. Flat children do not bind.
//   • the schema has no elementFormDefault, so the children are
//     UNQUALIFIED — no namespace prefix on any of them
//   • element ORDER is load-bearing (xs:sequence)
//   • the reply fields are errorString and retData, where the score reply
//     uses errorDescription and returnData
//   • retData is a DOUBLE-ENCODED JSON string needing a second parse
//
// ─── THE INCOME FIELDS GO ON THE WIRE EMPTY, ALWAYS ────────────────────
//
// pGrossIncomeAmount, pNetIncomeAmount and pLivingExpenses are required by
// the schema and must be sent as EMPTY STRINGS. Omitting them is
// schema-invalid; filling them in is worse — a declared figure suppresses
// the GMIP prediction entirely and Experian calculates against the
// patient's own number instead of predicting one. That would defeat the
// purpose of paying for the call.
//
// So this module's request builder takes no income parameter of any kind.
// There is no argument to pass a declared figure through, which is the
// only reliable way to guarantee one never goes out. The declared figure
// is applied later, in the pure limit function, where it can only lower a
// result.

import {
  experianCredentials,
  experianEndpoints,
  experianOrigin,
  experianOriginVersion,
  AFFORDABILITY_TIMEOUT_MS,
} from './config';
import { postSoap, xmlEscape, extractTag, extractFaultString, isSoapFault } from './soap';
import { redactEnvelope, maskIdsInText } from './redact';

const AFFORD_NAMESPACE = 'http://webServices/';

/** Experian's own confidence rating on its income prediction. */
export type GmipConfidenceLevel = 'High' | 'Medium' | 'Low' | 'Unable To Determine GMIP' | string;

/** The fields we read out of retData. Everything else is kept raw for the log. */
export type AffordabilityData = {
  gmipValue: number | null;
  gmipConfidenceLevel: GmipConfidenceLevel | null;
  gmipBand: string | null;
  bureauExpenses: number | null;
  calcLivingExpenses: number | null;
  /** Experian's OWN disposable-income figure, stored unmodified alongside
   *  ours. If a cohort goes bad we need to see whether the bureau saw it
   *  coming and our overlay masked it. */
  disposableIncome: number | null;
  /** Enquiry reference, for reconciliation against Experian's billing. */
  enqId: string | null;
  /** The full parsed payload, for the assessment log. */
  raw: Record<string, unknown>;
};

// ── Error codes (this service only) ───────────────────────────────────

export type AffordabilityDisposition =
  /** Answered, no usable prediction. Thin-file treatment. */
  | 'thin_file'
  /** Transient. Retry once, then pending. */
  | 'retry'
  /** Our configuration or our XML is wrong. Pending + alert loudly. */
  | 'alert';

type AffordErrorSpec = { disposition: AffordabilityDisposition; meaning: string };

export const AFFORDABILITY_ERROR_CODES: Readonly<Record<string, AffordErrorSpec>> = {
  '-201': { disposition: 'alert',     meaning: 'Parameters not binding — our XML is wrong' },
  '-204': { disposition: 'retry',     meaning: 'Generic server failure' },
  '-205': { disposition: 'alert',     meaning: 'Bad credentials or service not activated' },
  '-207': { disposition: 'alert',     meaning: 'Invalid ID number — should be unreachable, we validate first' },
  '-209': { disposition: 'thin_file', meaning: 'No GMIP available for this ID' },
  '-217': { disposition: 'thin_file', meaning: 'No bureau record for this ID' },
} as const;

export function affordabilityDispositionFor(code: string): AffordErrorSpec {
  return AFFORDABILITY_ERROR_CODES[code.trim()]
    ?? { disposition: 'alert', meaning: `Undocumented error code ${code}` };
}

export type AffordabilityCallOutcome =
  | { kind: 'data'; data: AffordabilityData }
  | { kind: 'error_code'; code: string; description: string; disposition: AffordabilityDisposition; meaning: string }
  | { kind: 'unavailable'; detail: string };

/**
 * Build the request envelope.
 *
 * Note the parameter list: an ID, and optionally a name and a spouse
 * enquiry reference. There is deliberately NO income parameter — see the
 * header.
 *
 * `pName` and `pSurname` are required by the schema but sent empty when
 * unknown, same as the income fields. `pPrimarySpouseEnquiryId` is the one
 * genuinely optional element and is omitted when absent.
 */
export function buildAffordabilityEnvelope(params: {
  username: string;
  password: string;
  origin: string;
  originVersion: string;
  requestVersion: string;
  outputFormat: string;
  idNumber: string;
  name?: string;
  surname?: string;
  primarySpouseEnquiryId?: string | null;
}): string {
  const spouse = params.primarySpouseEnquiryId
    ? `\n        <pPrimarySpouseEnquiryId>${xmlEscape(params.primarySpouseEnquiryId)}</pPrimarySpouseEnquiryId>`
    : '';

  // Order is an xs:sequence and is load-bearing. Do not reorder.
  return `<?xml version="1.0" encoding="UTF-8"?>
<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/">
  <S:Body>
    <ns:DoAffordability xmlns:ns="${AFFORD_NAMESPACE}">
      <request>
        <pUsername>${xmlEscape(params.username)}</pUsername>
        <pPassword>${xmlEscape(params.password)}</pPassword>
        <pOrigin>${xmlEscape(params.origin)}</pOrigin>
        <pOriginVersion>${xmlEscape(params.originVersion)}</pOriginVersion>
        <pRequestVersion>${xmlEscape(params.requestVersion)}</pRequestVersion>
        <pOutputFormat>${xmlEscape(params.outputFormat)}</pOutputFormat>
        <pIdNumber>${xmlEscape(params.idNumber)}</pIdNumber>
        <pName>${xmlEscape(params.name ?? '')}</pName>
        <pSurname>${xmlEscape(params.surname ?? '')}</pSurname>
        <pGrossIncomeAmount></pGrossIncomeAmount>
        <pNetIncomeAmount></pNetIncomeAmount>
        <pLivingExpenses></pLivingExpenses>${spouse}
      </request>
    </ns:DoAffordability>
  </S:Body>
</S:Envelope>`;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * Parse a reply body.
 *
 * Field names here are this service's: `errorString` and `retData`. Using
 * the score service's names would read every reply as malformed.
 */
export function parseAffordabilityResponse(xml: string): AffordabilityCallOutcome {
  if (isSoapFault(xml)) {
    const fault = extractFaultString(xml) ?? 'unknown fault';
    return { kind: 'unavailable', detail: `SOAP fault: ${maskIdsInText(fault)}` };
  }

  const errorCode = extractTag(xml, 'errorCode');
  if (errorCode !== null && errorCode.trim() !== '' && errorCode.trim() !== '0') {
    const code = errorCode.trim();
    const spec = affordabilityDispositionFor(code);
    return {
      kind: 'error_code',
      code,
      description: maskIdsInText(extractTag(xml, 'errorString') ?? ''),
      disposition: spec.disposition,
      meaning: spec.meaning,
    };
  }

  const retData = extractTag(xml, 'retData');
  if (retData === null || retData.trim() === '') {
    const completed = extractTag(xml, 'transactionCompleted');
    return { kind: 'unavailable', detail: `no retData (transactionCompleted=${completed ?? 'absent'})` };
  }

  // Double-encoded: the element contains a JSON *string* whose contents are
  // themselves JSON. One parse yields a string, the second the object.
  let payload: unknown;
  try {
    payload = JSON.parse(retData);
    if (typeof payload === 'string') payload = JSON.parse(payload);
  } catch {
    return { kind: 'unavailable', detail: 'retData was not parseable JSON' };
  }

  if (typeof payload !== 'object' || payload === null) {
    return { kind: 'unavailable', detail: 'retData did not decode to an object' };
  }

  const obj = payload as Record<string, unknown>;

  // Some deployments nest the result one level down. Take the nested object
  // when the expected keys are not at the top level.
  const body = ('GMIP_Value' in obj || 'GMIP_Confidence_Level' in obj)
    ? obj
    : (Object.values(obj).find(
        (v) => typeof v === 'object' && v !== null && 'GMIP_Value' in (v as object),
      ) as Record<string, unknown> | undefined) ?? obj;

  return {
    kind: 'data',
    data: {
      gmipValue:           numberOrNull(body.GMIP_Value),
      gmipConfidenceLevel: stringOrNull(body.GMIP_Confidence_Level),
      gmipBand:            stringOrNull(body.GMIP_Band),
      bureauExpenses:      numberOrNull(body.Bureau_Expenses),
      calcLivingExpenses:  numberOrNull(body.Calc_Living_Expenses),
      disposableIncome:    numberOrNull(body.Disposable_Income),
      enqId:               stringOrNull(body.Enq_id),
      raw:                 body,
    },
  };
}

/**
 * Call the affordability service.
 *
 * `idNumber` must already be checksum-validated — a -207 is a wasted
 * billable enquiry. Retries once, and only on a transient disposition or a
 * transport failure.
 */
export async function doAffordability(
  idNumber: string,
  opts: { name?: string; surname?: string; retryOnce?: boolean } = {},
): Promise<AffordabilityCallOutcome> {
  const retryOnce = opts.retryOnce ?? true;
  const creds = experianCredentials();
  const url   = experianEndpoints().affordability;

  const envelope = buildAffordabilityEnvelope({
    username:       creds.username,
    password:       creds.password,
    origin:         experianOrigin(),
    originVersion:  experianOriginVersion(),
    requestVersion: '1.0',
    outputFormat:   'json',
    idNumber,
    name:    opts.name,
    surname: opts.surname,
  });

  async function attempt(): Promise<AffordabilityCallOutcome> {
    const res = await postSoap(url, envelope, AFFORDABILITY_TIMEOUT_MS);

    if (res.kind === 'unavailable') {
      console.error('[experian:affordability] transport failure', { detail: res.detail });
      return { kind: 'unavailable', detail: res.detail };
    }

    const outcome = parseAffordabilityResponse(res.xml);

    if (outcome.kind === 'unavailable' && res.status >= 400) {
      console.error('[experian:affordability] error response', {
        status: res.status,
        detail: outcome.detail,
        request: redactEnvelope(envelope),
      });
    }

    if (outcome.kind === 'error_code' && outcome.disposition === 'alert') {
      console.error('[experian:affordability] ALERT bureau refused the request', {
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
