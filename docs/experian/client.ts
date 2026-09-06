/**
 * Experian Person Get Score — SOAP transport.
 *
 * Spec: "Experian Person Get Score Integration Specification" v2.1, corrected against the
 * live WSDL at https://apis-uat.experian.co.za/GetPersonScore?wsdl — which disagrees with
 * the PDF in three places, all of them load-bearing (see notes on buildRequest below).
 *
 * SOAP over 443, not REST over 9443. Measured reason: 9443 is source-restricted. It is
 * reachable from a South African connection and times out from cloud datacentre IPs,
 * which is what Vercel functions run on. 443 answered from both.
 *
 * SERVER ONLY. The request body contains the password in cleartext. Never log it,
 * never attach it to an error report, never return it from a route handler.
 */

export const EXPERIAN_ENDPOINTS = {
  uat: 'https://apis-uat.experian.co.za/GetPersonScore',
  live: 'https://apis.experian.co.za/GetPersonScore',
} as const;

export type ExperianEnv = keyof typeof EXPERIAN_ENDPOINTS;

export interface ExperianConfig {
  env: ExperianEnv;
  username: string; // pUsername, max 35
  password: string; // pPassword, max 35
  origin: string; // pMyOrigin, max 30 — set 'BetterNow' so Experian-side logs are attributable
  /**
   * pVersion, max 5. v2.1 documents '1.0' (CPA & NLR) and '2.0' (Compuscore V3 CT/CU).
   * It shows Sigma output in §8 but never states which pVersion returns it. Confirm
   * against a real call before relying on it; a wrong value returns -105, still billable.
   */
  pVersion: string;
  timeoutMs: number;
}

export interface ScoreReason {
  code: string;
  description: string;
}

export interface ScoreResult {
  resultType: string;
  /** Verbatim from the payload. §8 types score as Number; the wire sends "614". */
  rawScore: string;
  /** POSITIVE = a real score. NEGATIVE = a warning code, NOT a low score. See scores.ts. */
  score: number | null;
  reasons: ScoreReason[];
}

export type ExperianOutcome =
  | { kind: 'ok'; idNumber: string | null; results: ScoreResult[]; raw: string; latencyMs: number }
  | { kind: 'thin_file'; errorCode: string; errorDescription: string; latencyMs: number }
  | { kind: 'input_error'; errorCode: string; errorDescription: string; latencyMs: number }
  | { kind: 'config_error'; errorCode: string; errorDescription: string; latencyMs: number }
  | { kind: 'provider_error'; errorCode: string; errorDescription: string; latencyMs: number }
  | { kind: 'transport_error'; reason: string; httpStatus: number | null; latencyMs: number };

/** §9, grouped by what we should DO rather than by numeric range. */
const ERROR_CLASS: Record<string, 'thin_file' | 'input_error' | 'config_error' | 'provider_error'> = {
  '-101': 'config_error', // Not all variables filled in — our request builder is broken
  '-105': 'config_error', // Input version not supported — wrong pVersion
  '-106': 'provider_error',
  '-107': 'config_error', // Invalid user details or user inactive
  '-108': 'config_error', // Result type not supported
  '-110': 'config_error', // Branch not switched on for this service
  '-113': 'input_error',
  '-114': 'input_error', // Invalid Id number supplied
  '-115': 'thin_file',
  '-116': 'config_error', // Branch not switched on for any CompuScore version
  '-999': 'provider_error',
};

function escapeXml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(v: string): string {
  // &amp; last, or "&amp;lt;" would wrongly collapse to "<".
  return v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Namespace-tolerant single-element extractor. The responses are flat, known-shape
 * documents (four scalar fields), so a full XML parser would be a dependency bought for
 * nothing. Safe here specifically because returnData arrives XML-ESCAPED — its contents
 * cannot contain a literal closing tag to terminate the match early.
 */
function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? m[1] : null;
}

/**
 * Element order is an xs:sequence and the WSDL order is NOT the PDF's parameter-table
 * order. Schema order: pUsername, pPassword, pMyOrigin, pVersion, pResultType, pIdNumber.
 *
 * NAMESPACE, and this one is a trap that costs a billable transaction to discover:
 * the schema declares no elementFormDefault, so it defaults to UNQUALIFIED. The wrapper
 * <getScore> is in http://services/, but every child must be in NO namespace. Declaring
 * the namespace as a default (xmlns="http://services/") inherits it to all six children,
 * JAX-WS binds none of them, and the server answers -101 "Not all variables filled in"
 * — which reads like a missing field rather than a namespace fault. So: PREFIXED
 * declaration on the wrapper only. Proven against UAT: default-ns returns -101,
 * prefixed returns -107 with bad credentials, i.e. the parameters bound and it reached auth.
 * Corroborating evidence in every response: <TransactionReplyClass xmlns=""> and
 * <return xmlns="">true</return>.
 *
 * Also note, against the PDF: the real transactionReplyClass has NO `hasErrors` field
 * (only errorCode, errorDescription, returnData, transactionCompleted), and the WSDL
 * exposes an undocumented zero-argument `pingServer` operation — see ping() below.
 */
function buildRequest(idNumber: string, cfg: ExperianConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/">
  <S:Body>
    <ns:getScore xmlns:ns="http://services/">
      <pUsername>${escapeXml(cfg.username)}</pUsername>
      <pPassword>${escapeXml(cfg.password)}</pPassword>
      <pMyOrigin>${escapeXml(cfg.origin)}</pMyOrigin>
      <pVersion>${escapeXml(cfg.pVersion)}</pVersion>
      <pResultType>json</pResultType>
      <pIdNumber>${escapeXml(idNumber)}</pIdNumber>
    </ns:getScore>
  </S:Body>
</S:Envelope>`;
}

/**
 * §8: returnData is a STRING containing a whole document — you unescape, then parse.
 * Tolerates the shapes the spec's own examples show:
 *   { idNumber, results: [...] }   V2/V3 JSON examples
 *   { results: [...] }             the Sigma example root carries no idNumber
 *   { result:  [...] }             singular, defensive
 */
export function parseReturnData(returnData: string): { idNumber: string | null; results: ScoreResult[] } {
  let body = unescapeXml(returnData).trim();
  // Present when pResultType is XML; harmless to strip defensively.
  body = body.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();

  const doc = JSON.parse(body) as Record<string, unknown>;
  const rawResults = doc.results ?? doc.result;
  const list = Array.isArray(rawResults) ? rawResults : rawResults ? [rawResults] : [];

  const results: ScoreResult[] = list.map((entry) => {
    const r = entry as Record<string, unknown>;
    const rawScore = r.score == null ? '' : String(r.score);
    const parsed = rawScore.trim() === '' ? NaN : Number(rawScore);
    const rawReasons = r.reasons;
    const reasonList = Array.isArray(rawReasons) ? rawReasons : rawReasons ? [rawReasons] : [];

    return {
      resultType: String(r.resultType ?? '').trim().toUpperCase(),
      rawScore,
      score: Number.isFinite(parsed) ? parsed : null,
      reasons: reasonList.map((x) => {
        const rr = x as Record<string, unknown>;
        return {
          code: String(rr.reasonCode ?? '').trim(),
          description: String(rr.reasonDescription ?? '').trim(),
        };
      }),
    };
  });

  const idNumber = String(doc.idNumber ?? '').trim();
  return { idNumber: idNumber === '' ? null : idNumber, results };
}

async function postSoap(url: string, body: string, timeoutMs: number): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=UTF-8', SOAPAction: '""' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
}

/**
 * Undocumented in the PDF, present in the WSDL: zero arguments, no credentials, free.
 * Use this for uptime monitoring instead of burning a billable getScore.
 */
export async function ping(env: ExperianEnv, timeoutMs = 15000): Promise<boolean> {
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<S:Body><pingServer xmlns="http://services/"/></S:Body></S:Envelope>';
  try {
    const res = await postSoap(EXPERIAN_ENDPOINTS[env], body, timeoutMs);
    if (!res.ok) return false;
    return /<(?:\w+:)?return[^>]*>true<\/(?:\w+:)?return>/.test(await res.text());
  } catch {
    return false;
  }
}

/**
 * One billable call. No retries in here on purpose: a returned envelope means Experian
 * processed the transaction, and §3 makes every transaction billable. Retry policy is
 * the caller's decision, with a persisted attempt row behind it.
 */
export async function getScore(idNumber: string, cfg: ExperianConfig): Promise<ExperianOutcome> {
  const started = Date.now();
  let res: Response;

  try {
    res = await postSoap(EXPERIAN_ENDPOINTS[cfg.env], buildRequest(idNumber, cfg), cfg.timeoutMs);
  } catch (err) {
    // Deliberately carries no request detail. An unredacted SOAP body in a Sentry
    // breadcrumb is a cleartext password — the same leak already stripped once from
    // the diagnostic logs.
    return {
      kind: 'transport_error',
      reason: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown fetch failure',
      httpStatus: null,
      latencyMs: Date.now() - started,
    };
  }

  const latencyMs = Date.now() - started;
  const text = await res.text();

  // A SOAP fault arrives as HTTP 500, so check the body shape before trusting the status.
  if (/<(?:\w+:)?Fault[\s>]/.test(text)) {
    const fault = tag(text, 'faultstring') ?? 'unspecified SOAP fault';
    return { kind: 'provider_error', errorCode: '-999', errorDescription: unescapeXml(fault), latencyMs };
  }

  if (!res.ok) {
    return { kind: 'transport_error', reason: `http ${res.status}`, httpStatus: res.status, latencyMs };
  }

  const completed = (tag(text, 'transactionCompleted') ?? '').trim().toLowerCase() === 'true';
  const code = (tag(text, 'errorCode') ?? '').trim();
  const description = unescapeXml((tag(text, 'errorDescription') ?? '').trim());

  if (!completed) {
    const kind = ERROR_CLASS[code] ?? 'provider_error';
    return { kind, errorCode: code || '-999', errorDescription: description, latencyMs };
  }

  const returnData = tag(text, 'returnData');
  if (!returnData || returnData.trim() === '') {
    return { kind: 'provider_error', errorCode: '-999', errorDescription: 'completed with empty returnData', latencyMs };
  }

  try {
    const { idNumber: echoed, results } = parseReturnData(returnData);
    return { kind: 'ok', idNumber: echoed, results, raw: unescapeXml(returnData), latencyMs };
  } catch (err) {
    return {
      kind: 'provider_error',
      errorCode: '-999',
      errorDescription: `unparseable returnData: ${err instanceof Error ? err.message : 'unknown'}`,
      latencyMs,
    };
  }
}
