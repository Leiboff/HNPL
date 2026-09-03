// ─── Recorded GetPersonScore replies ────────────────────────────────────
//
// `SCORE_SUCCESS_SU_UNSCORABLE_STS_620` is a VERBATIM UAT capture, with
// only the ID number substituted for the spec's own example value. It is
// the reference for the whole integration: the operation name, the reply
// element names, the empty-string errorCode and the double-card result
// shape all come from here rather than from the PDF.
//
// The remainder are constructed to that exact shape, changing one thing at
// a time. Tests must never reach the live API — every one of these is a
// string.

/** ID used throughout the fixtures. The integration spec's own example. */
export const FIXTURE_ID = '7408285107080';

/**
 * THE LIVE CAPTURE. HTTP 200, ~1.7s.
 *
 * SU (Sigma Unsecured Credit) cannot score this applicant — score -1 with
 * reason MI62, "no accounts open for more than 3 months". STS (Sigma
 * Transcend), the thin-file card, scores them 620 → Low Risk.
 *
 * Note: errorCode and errorDescription are present but EMPTY on success,
 * and there is no `hasErrors` element despite the spec documenting one.
 */
export const SCORE_SUCCESS_SU_UNSCORABLE_STS_620 = `<?xml version="1.0" ?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:getScoreResponse xmlns:ns2="http://services/"><TransactionReplyClass xmlns=""><errorCode></errorCode><errorDescription></errorDescription><returnData>{"idNumber":"${FIXTURE_ID}","results":[{"resultType":"SU","score":"-1","reasons":[{"reasonCode":"MI62","reasonDescription":"MI62-Customer has no Accounts that have been open for more than 3 months"}]},{"resultType":"STS","score":"620","reasons":[]}]}</returnData><transactionCompleted>true</transactionCompleted></TransactionReplyClass></ns2:getScoreResponse></S:Body></S:Envelope>`;

/** Helper: a success reply carrying an arbitrary set of cards. */
export function scoreReplyWith(
  results: Array<{ resultType: string; score: string; reasons?: Array<{ reasonCode: string; reasonDescription: string }> }>,
  idNumber = FIXTURE_ID,
): string {
  const payload = JSON.stringify({
    idNumber,
    results: results.map((r) => ({ ...r, reasons: r.reasons ?? [] })),
  });
  return `<?xml version="1.0" ?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:getScoreResponse xmlns:ns2="http://services/"><TransactionReplyClass xmlns=""><errorCode></errorCode><errorDescription></errorDescription><returnData>${payload}</returnData><transactionCompleted>true</transactionCompleted></TransactionReplyClass></ns2:getScoreResponse></S:Body></S:Envelope>`;
}

/** SU scores the applicant outright — no fallback needed. */
export const SCORE_SUCCESS_SU_SCORED_660 = scoreReplyWith([
  { resultType: 'SU', score: '660' },
  { resultType: 'STS', score: '615' },
]);

/** SU puts the applicant in Very High Risk — a band decline. */
export const SCORE_SUCCESS_SU_VERY_HIGH = scoreReplyWith([
  { resultType: 'SU', score: '600' },
]);

/** Deceased sentinel on the primary card. */
export const SCORE_SENTINEL_DECEASED = scoreReplyWith([
  { resultType: 'SU', score: '-2' },
  { resultType: 'STS', score: '640' },
]);

/** Under debt review — an NCA prohibition, never approvable. */
export const SCORE_SENTINEL_DEBT_REVIEW = scoreReplyWith([
  { resultType: 'SU', score: '-4' },
  { resultType: 'STS', score: '700' },
]);

/** Bureau dispute — review, not a verdict. */
export const SCORE_SENTINEL_DISPUTE = scoreReplyWith([
  { resultType: 'SU', score: '-5' },
]);

/** Both cards unscorable — genuine thin file with no fallback available. */
export const SCORE_BOTH_UNSCORABLE = scoreReplyWith([
  { resultType: 'SU', score: '-1' },
  { resultType: 'STS', score: '-1' },
]);

/** The branch is switched on for cards we did not ask for. Config error. */
export const SCORE_UNEXPECTED_CARDS_ONLY = scoreReplyWith([
  { resultType: 'SBF', score: '650' },
]);

// ── Coded errors ──────────────────────────────────────────────────────

function errorReply(code: string, description: string): string {
  return `<?xml version="1.0" ?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:getScoreResponse xmlns:ns2="http://services/"><TransactionReplyClass xmlns=""><errorCode>${code}</errorCode><errorDescription>${description}</errorDescription><returnData></returnData><transactionCompleted>false</transactionCompleted></TransactionReplyClass></ns2:getScoreResponse></S:Body></S:Envelope>`;
}

/** -115 Thin file, no data available. Thin-file treatment, not an error. */
export const SCORE_ERROR_115_THIN_FILE = errorReply(
  '-115', 'Thin file - No data available for the Id number supplied.');

/** -107 Bad credentials / user inactive. Alert. Never a patient-facing decline. */
export const SCORE_ERROR_107_BAD_CREDENTIALS = errorReply(
  '-107', 'Invalid user details supplied or user inactive.');

/** -101 Our envelope is malformed. Alert loudly. */
export const SCORE_ERROR_101_NOT_BOUND = errorReply(
  '-101', 'Not all variables filled in.');

/** -110 Branch not switched on for this service. Alert. */
export const SCORE_ERROR_110_BRANCH_OFF = errorReply(
  '-110', 'Your branch is not switched on for this service.');

/** -114 Invalid ID. Should be unreachable — we validate the checksum first. */
export const SCORE_ERROR_114_INVALID_ID = errorReply(
  '-114', 'Invalid Id number supplied.');

/** -106 Transient server failure. Retry once, then pending. */
export const SCORE_ERROR_106_TRANSIENT = errorReply(
  '-106', 'Something went wrong while your transaction was executing.');

/** -999 Unknown. Retry once, then pending. */
export const SCORE_ERROR_999_UNKNOWN = errorReply('-999', 'Unknown Error.');

/** An undocumented code. Must resolve to pending, never a decline. */
export const SCORE_ERROR_UNDOCUMENTED = errorReply('-4242', 'Something new.');

// ── Faults ────────────────────────────────────────────────────────────

/**
 * A SOAP fault. Arrives as HTTP 500 with the fault in the BODY — reading
 * only the status throws away the one diagnostic available.
 */
export const SCORE_SOAP_FAULT_500 = `<?xml version="1.0" ?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault xmlns:ns4="http://www.w3.org/2003/05/soap-envelope"><faultcode>S:Server</faultcode><faultstring>Cannot find dispatch method for {http://services/}getScoreRequest</faultstring></S:Fault></S:Body></S:Envelope>`;

/** A fault whose text echoes the applicant's ID — must be masked in logs. */
export const SCORE_SOAP_FAULT_WITH_ID = `<?xml version="1.0" ?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault><faultcode>S:Server</faultcode><faultstring>Lookup failed for ${FIXTURE_ID}</faultstring></S:Fault></S:Body></S:Envelope>`;

/** An HTML error page from a proxy — not SOAP at all. */
export const SCORE_HTML_ERROR_PAGE =
  '<html><head><title>503 Service Unavailable</title></head><body><h1>503</h1></body></html>';
