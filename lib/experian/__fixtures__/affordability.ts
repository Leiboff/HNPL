// ─── Recorded DoAffordability replies ───────────────────────────────────
//
// Built to the shape the verified schema notes describe: reply fields
// `errorString` and `retData` (not the score service's errorDescription /
// returnData), and a retData that is DOUBLE-ENCODED — a JSON string whose
// contents are themselves JSON, needing two parses.
//
// Both encodings appear here on purpose. The double form is what the
// service documents; the single form is what some deployments actually
// send, and the parser accepts either. A fixture for only one would let a
// regression through on the other.

export const FIXTURE_ID = '7408285107080';

type AffordPayload = Record<string, unknown>;

/** A High-confidence prediction with plausible expense figures. */
export const PAYLOAD_HIGH: AffordPayload = {
  GMIP_Value: '30000',
  GMIP_Confidence_Level: 'High',
  GMIP_Band: 'R25 001 - R35 000',
  Bureau_Expenses: '2000',
  Calc_Living_Expenses: '6000',
  Disposable_Income: '17200',
  Enq_id: 'ENQ-1000001',
};

/** Same applicant, Medium confidence — the 0.85 haircut applies. */
export const PAYLOAD_MEDIUM: AffordPayload = {
  ...PAYLOAD_HIGH,
  GMIP_Confidence_Level: 'Medium',
  Enq_id: 'ENQ-1000002',
};

/** Low confidence — thin-file treatment, not an error. */
export const PAYLOAD_LOW: AffordPayload = {
  ...PAYLOAD_HIGH,
  GMIP_Confidence_Level: 'Low',
  Enq_id: 'ENQ-1000003',
};

/** The literal string Experian sends when it cannot predict at all. */
export const PAYLOAD_UNABLE: AffordPayload = {
  GMIP_Value: '',
  GMIP_Confidence_Level: 'Unable To Determine GMIP',
  GMIP_Band: '',
  Bureau_Expenses: '1500',
  Calc_Living_Expenses: '4000',
  Disposable_Income: '',
  Enq_id: 'ENQ-1000004',
};

/** A modest earner whose formula result lands below the band ceiling. */
export const PAYLOAD_MODEST: AffordPayload = {
  GMIP_Value: '12000',
  GMIP_Confidence_Level: 'High',
  GMIP_Band: 'R10 001 - R15 000',
  Bureau_Expenses: '1500',
  Calc_Living_Expenses: '4000',
  Disposable_Income: '5900',
  Enq_id: 'ENQ-1000005',
};

function envelope(retDataText: string): string {
  return `<?xml version="1.0" ?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:DoAffordabilityResponse xmlns:ns2="http://webServices/"><return xmlns=""><transactionCompleted>true</transactionCompleted><errorCode></errorCode><errorString></errorString><retData>${retDataText}</retData></return></ns2:DoAffordabilityResponse></S:Body></S:Envelope>`;
}

/** DOUBLE-encoded retData — the documented form. */
export function affordabilityReply(payload: AffordPayload): string {
  return envelope(JSON.stringify(JSON.stringify(payload)));
}

/** SINGLE-encoded retData — observed in some deployments. */
export function affordabilityReplySingleEncoded(payload: AffordPayload): string {
  return envelope(JSON.stringify(payload));
}

export const AFFORD_SUCCESS_HIGH          = affordabilityReply(PAYLOAD_HIGH);
export const AFFORD_SUCCESS_HIGH_SINGLE   = affordabilityReplySingleEncoded(PAYLOAD_HIGH);
export const AFFORD_SUCCESS_MEDIUM        = affordabilityReply(PAYLOAD_MEDIUM);
export const AFFORD_SUCCESS_LOW           = affordabilityReply(PAYLOAD_LOW);
export const AFFORD_SUCCESS_UNABLE        = affordabilityReply(PAYLOAD_UNABLE);
export const AFFORD_SUCCESS_MODEST        = affordabilityReply(PAYLOAD_MODEST);

// ── Coded errors ──────────────────────────────────────────────────────

function errorReply(code: string, message: string): string {
  return `<?xml version="1.0" ?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:DoAffordabilityResponse xmlns:ns2="http://webServices/"><return xmlns=""><transactionCompleted>false</transactionCompleted><errorCode>${code}</errorCode><errorString>${message}</errorString><retData></retData></return></ns2:DoAffordabilityResponse></S:Body></S:Envelope>`;
}

/** -209 No GMIP for this ID. Thin-file treatment. */
export const AFFORD_ERROR_209_NO_GMIP = errorReply('-209', 'No GMIP available for the supplied ID number.');

/** -217 No bureau record. Thin-file treatment. */
export const AFFORD_ERROR_217_NO_RECORD = errorReply('-217', 'No bureau record found.');

/** -205 Bad credentials / service not activated. Alert, never a decline. */
export const AFFORD_ERROR_205_NOT_ACTIVATED = errorReply('-205', 'Service not activated for this user.');

/** -207 Invalid ID. Should be unreachable — we validate the checksum first. */
export const AFFORD_ERROR_207_INVALID_ID = errorReply('-207', 'Invalid ID number supplied.');

/** -204 Generic server failure. Retry once, then pending. */
export const AFFORD_ERROR_204_GENERIC = errorReply('-204', 'Server error.');

/** -201 Parameters not binding. Our XML is wrong. Alert loudly. */
export const AFFORD_ERROR_201_NOT_BINDING = errorReply('-201', 'Required parameters not supplied.');

/** An undocumented code — must resolve to pending, never a decline. */
export const AFFORD_ERROR_UNDOCUMENTED = errorReply('-9999', 'Novel failure.');

// ── Faults ────────────────────────────────────────────────────────────

/**
 * A SOAP fault, HTTP 500, fault in the body. This particular faultstring
 * is what a flat (unwrapped) request produces — the parameters do not bind
 * to AffordRequestParamsType.
 */
export const AFFORD_SOAP_FAULT_500 = `<?xml version="1.0" ?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault><faultcode>S:Server</faultcode><faultstring>Unmarshalling Error: unexpected element (uri:"", local:"pUsername"). Expected elements are &lt;{}request&gt;</faultstring></S:Fault></S:Body></S:Envelope>`;

/** Truncated / non-XML body. */
export const AFFORD_GARBAGE_BODY = 'Bad Gateway';
