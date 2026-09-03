// SERVER-ONLY. Never import in a client component.
//
// ─── SOAP transport and XML plumbing. Nothing service-specific ──────────
//
// Deliberately contains no element names, no error codes and no field
// semantics. `getScore` and `DoAffordability` are two different
// deployments that disagree about almost everything — namespace, whether
// parameters are wrapped, and even what the reply fields are called
// (`errorDescription`/`returnData` on one, `errorString`/`retData` on the
// other). A shared client that "unifies" them would have to pick one
// vocabulary and silently mis-read the other, so what is shared here is
// only the parts that genuinely are: posting XML over HTTPS and pulling a
// named element back out.
//
// ─── A SOAP FAULT IS AN HTTP 500 WITH THE ANSWER IN THE BODY ───────────
//
// Faults do not arrive as a structured error alongside a 2xx. They arrive
// as HTTP 500, and `faultstring` in the body says what is actually wrong —
// wrong element order, an unbound parameter, a schema violation. Logging
// the status and discarding the body throws away the only diagnostic
// there is, so `postSoap` reads the body on EVERY status and hands it
// back; deciding what a 500 means belongs to the service client.

/** Escape a value for inclusion in XML text content. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Decode the five predefined entities plus numeric character references. */
export function xmlDecode(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // Ampersand last, so "&amp;lt;" decodes to "&lt;" and not to "<".
    .replace(/&amp;/g, '&');
}

/**
 * The text content of the first element with this local name, decoded.
 *
 * Local-name matching ignores the namespace prefix, which varies between
 * the two services and between request and reply (`ns2:getScoreResponse`
 * but a bare `<returnData>`). Returns null when absent, and an empty
 * string when the element is present but empty — a distinction that
 * matters, because `errorCode` is EMPTY on success rather than "0", and
 * conflating "no element" with "empty element" would make every successful
 * call look like a malformed one.
 */
export function extractTag(xml: string, localName: string): string | null {
  const paired = new RegExp(
    `<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${localName}>`,
  );
  const match = paired.exec(xml);
  if (match) return xmlDecode(match[1]);

  // Self-closing form, e.g. <errorCode/> — present and empty.
  const selfClosing = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*/>`);
  return selfClosing.test(xml) ? '' : null;
}

/** `faultstring` from a SOAP fault body, if this is one. */
export function extractFaultString(xml: string): string | null {
  return extractTag(xml, 'faultstring');
}

/** True when the body is a SOAP Fault rather than a normal reply. */
export function isSoapFault(xml: string): boolean {
  return /<(?:[A-Za-z0-9_.-]+:)?Fault\b/.test(xml);
}

export type SoapPostResult =
  /** We got bytes back. Any status — the caller decides what it means. */
  | { kind: 'body'; status: number; xml: string }
  /** Nothing came back: timeout, DNS, connection reset, abort. */
  | { kind: 'unavailable'; detail: string };

/**
 * POST a SOAP envelope.
 *
 * NEVER logs `envelope` — it carries the service password in cleartext.
 * See redact.ts; callers that need to log a request log the redacted form
 * and only on a failure path.
 */
export async function postSoap(
  url: string,
  envelope: string,
  timeoutMs: number,
  soapAction = '',
): Promise<SoapPostResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        'SOAPAction':   soapAction,
      },
      body: envelope,
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Read the body regardless of status — a fault lives in a 500.
    const xml = await res.text();
    return { kind: 'body', status: res.status, xml };
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { kind: 'unavailable', detail };
  }
}
