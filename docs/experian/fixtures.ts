/**
 * Experian response fixtures.
 *
 * Two of these are REAL payloads captured from production (Aug 2026) — they are the
 * ground truth for shape. The rest are synthetic, constructed from the spec, to cover
 * branches you cannot lawfully obtain: you would need a deceased person's ID, a
 * sequestrated person's ID, someone under debt review. Those records exist, but pulling
 * them requires that person's consent and a lawful purpose, and no amount of paying
 * Experian substitutes for either.
 *
 * When Experian issue UAT credentials and seeded test IDs, replace the synthetic ones
 * with captured UAT payloads and delete this note.
 */

/** The `returnData` string as it arrives, already XML-unescaped. */
export const FIXTURES = {
  // ---- REAL: captured from production ----------------------------------------
  real_nlr_cpa_credit_active:
    '{"idNumber":"REDACTED","results":[' +
    '{"resultType":"NLR","score":"650","reasons":[{"reasonCode":"NA31","reasonDescription":"NA31-High Utilisation on Revolving Accounts"}]},' +
    '{"resultType":"CPA","score":"664","reasons":[{"reasonCode":"CA31","reasonDescription":"CA31-High Utilisation on Revolving Accounts"}]}]}',

  real_ss_minimum_risk:
    '{"idNumber":"REDACTED","results":[' +
    '{"resultType":"SS","score":"684","reasons":[' +
    '{"reasonCode":"TM61","reasonDescription":"TM61-No record of property deeds"},' +
    '{"reasonCode":"TM44","reasonDescription":"TM44-Balance or Limit Volatility over Last 12 months"}]}]}',

  // ---- SYNTHETIC: band boundaries (SS, from §5.3) -----------------------------
  ss_band1_upper: '{"results":[{"resultType":"SS","score":"598","reasons":[]}]}',
  ss_band2_lower: '{"results":[{"resultType":"SS","score":"599","reasons":[]}]}',
  ss_band4_upper: '{"results":[{"resultType":"SS","score":"657","reasons":[]}]}',
  ss_band5_lower: '{"results":[{"resultType":"SS","score":"658","reasons":[]}]}',

  /** REAL: a genuine thin file. Note the reason code arrives WITH the warning value,
   *  and no STS card accompanies it despite Transcend being provisioned. */
  real_su_thin_file:
    '{"idNumber":"REDACTED","results":[{"resultType":"SU","score":"-1","reasons":[' +
    '{"reasonCode":"MI62","reasonDescription":"MI62-Customer has no Accounts that have been open for more than 3 months"}]}]}',

  /** REAL: credit-active on the activated SU card. */
  real_su_credit_active:
    '{"idNumber":"REDACTED","results":[{"resultType":"SU","score":"657","reasons":[' +
    '{"reasonCode":"MI39","reasonDescription":"MI39-Recent Increase in Overdue Balance Levels"}]}]}',

  // ---- SYNTHETIC: Sigma warning codes (§5.5) ----------------------------------
  ss_thin_file: '{"results":[{"resultType":"SS","score":"-1","reasons":[]}]}',
  ss_deceased: '{"results":[{"resultType":"SS","score":"-2","reasons":[]}]}',
  ss_sequestrated: '{"results":[{"resultType":"SS","score":"-3","reasons":[]}]}',
  ss_debt_review: '{"results":[{"resultType":"SS","score":"-4","reasons":[]}]}',
  ss_bureau_dispute: '{"results":[{"resultType":"SS","score":"-5","reasons":[]}]}',
  ss_fraud: '{"results":[{"resultType":"SS","score":"-6","reasons":[]}]}',
  ss_unknown_warning: '{"results":[{"resultType":"SS","score":"-99","reasons":[]}]}',

  /** An identity-level flag on one card decides the whole application. */
  mixed_deceased_and_good:
    '{"results":[{"resultType":"SS","score":"690","reasons":[]},{"resultType":"SU","score":"-2","reasons":[]}]}',

  /** Thin on one card only is NOT a thin file — §8 shows SCM -1 next to a scored SU. */
  mixed_one_card_thin:
    '{"results":[{"resultType":"SCM","score":"-1","reasons":[]},{"resultType":"SS","score":"640","reasons":[]}]}',

  // ---- SYNTHETIC: legacy 1-4 thin file (§4.1) ---------------------------------
  legacy_thin_file: '{"results":[{"resultType":"NLR","score":"3","reasons":[]},{"resultType":"CPA","score":"2","reasons":[]}]}',
  legacy_thin_floor: '{"results":[{"resultType":"NLR","score":"479","reasons":[]}]}',

  // ---- SYNTHETIC: structural edges --------------------------------------------
  no_results: '{"idNumber":"REDACTED","results":[]}',
  singular_result_key: '{"result":{"resultType":"SS","score":"684","reasons":[]}}',
  no_id_echoed: '{"results":[{"resultType":"SS","score":"684","reasons":[]}]}',
  unknown_scorecard: '{"results":[{"resultType":"ZZZ","score":"600","reasons":[]}]}',
  reason_with_metachars:
    '{"results":[{"resultType":"SS","score":"640","reasons":[{"reasonCode":"TM53","reasonDescription":"Unsecured Credit & Short Term <loans> indicate \\"high\\" risk"}]}]}',
} as const;

/** Full SOAP envelopes, for exercising the transport rather than the parser. */
function escapeXml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function soapSuccess(returnData: string): string {
  return (
    '<?xml version="1.0"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>' +
    '<ns2:getScoreResponse xmlns:ns2="http://services/"><TransactionReplyClass xmlns="">' +
    '<errorCode></errorCode><errorDescription></errorDescription>' +
    `<returnData>${escapeXml(returnData)}</returnData>` +
    '<transactionCompleted>true</transactionCompleted>' +
    '</TransactionReplyClass></ns2:getScoreResponse></S:Body></S:Envelope>'
  );
}

export function soapError(code: string, description: string): string {
  return (
    '<?xml version="1.0"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>' +
    '<ns2:getScoreResponse xmlns:ns2="http://services/"><TransactionReplyClass xmlns="">' +
    `<errorCode>${code}</errorCode><errorDescription>${escapeXml(description)}</errorDescription>` +
    '<transactionCompleted>false</transactionCompleted>' +
    '</TransactionReplyClass></ns2:getScoreResponse></S:Body></S:Envelope>'
  );
}

export const soapFault =
  '<?xml version="1.0"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>' +
  '<S:Fault><faultstring>Server was unable to process request.</faultstring></S:Fault>' +
  '</S:Body></S:Envelope>';

/** Every documented error code, §9. */
export const ERROR_CODES: Array<[string, string]> = [
  ['-101', 'Not all variables filled in.'],
  ['-105', 'Input version not supported'],
  ['-106', 'Something went wrong while your transaction was executing.'],
  ['-107', 'Invalid user details supplied or user inactive.'],
  ['-108', 'Result type not supported.'],
  ['-110', 'Your branch is not switched on for this service.'],
  ['-113', 'Id Number not supplied'],
  ['-114', 'Invalid Id number supplied.'],
  ['-115', 'Thin file - No data available for the Id number supplied.'],
  ['-116', 'Your branch is not switched on for any CompuScore version.'],
  ['-999', 'Unknown Error.'],
];
