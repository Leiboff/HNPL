// ─── Redaction for anything Experian-shaped that might reach a log ──────
//
// The SOAP request body carries `pUsername` and `pPassword` in CLEARTEXT.
// There is no signature, no bearer token, no way to log the request "just
// for debugging" without writing the service credentials to whatever
// aggregator the platform ships logs to.
//
// So the rule is absolute: the raw envelope is never logged. Not at error
// level, not behind a debug flag, not truncated. `redactEnvelope` exists
// so that the useful part — the shape of what we sent — stays available
// when an integration bug needs diagnosing.
//
// ID numbers are masked with the same helper the rest of the app uses
// (lib/saIdMask.ts), so a support engineer reading logs sees the same
// last-four form everywhere and no surface leaks a date of birth.

import { maskSaId } from '@/lib/saIdMask';

/** Elements whose contents are replaced wholesale. */
const SECRET_ELEMENTS = ['pUsername', 'pPassword'];

/** Elements whose contents are masked but left partially readable. */
const ID_ELEMENTS = ['pIdNumber', 'idNumber'];

function replaceElement(xml: string, localName: string, replace: (inner: string) => string): string {
  // Local-name match: the prefix varies by service and by whether the
  // element is in the request or the reply.
  const pattern = new RegExp(
    `(<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*>)([\\s\\S]*?)(</(?:[A-Za-z0-9_.-]+:)?${localName}>)`,
    'g',
  );
  return xml.replace(pattern, (_m, open: string, inner: string, close: string) =>
    `${open}${replace(inner)}${close}`);
}

/**
 * A version of a SOAP envelope that is safe to log.
 *
 * Credentials are replaced with a fixed marker (not a length-preserving
 * mask — the length of a password is itself worth not publishing), and ID
 * numbers are reduced to their last four digits.
 *
 * Returns a short placeholder for nullish input so a caller cannot
 * accidentally log `undefined` and conclude the request was empty.
 */
export function redactEnvelope(xml: string | null | undefined): string {
  if (!xml) return '<empty>';

  let out = xml;
  for (const el of SECRET_ELEMENTS) {
    out = replaceElement(out, el, () => '[REDACTED]');
  }
  for (const el of ID_ELEMENTS) {
    out = replaceElement(out, el, (inner) => maskSaId(inner.trim()));
  }
  return out;
}

/**
 * Mask any bare 13-digit SA ID appearing in free text — a fault string, an
 * error description, a JSON payload echoed back by the bureau.
 *
 * Complements `redactEnvelope`, which only knows about elements it can
 * name. Applied to anything from the wire that reaches a log.
 */
export function maskIdsInText(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\b\d{13}\b/g, (id) => maskSaId(id));
}

/**
 * The safe summary of an outbound call: which service, how big the body
 * was, and nothing else. Preferred over logging even a redacted envelope
 * on the success path — the redacted form is for diagnosing a failure, not
 * for routine observability.
 */
export function requestSummary(service: 'score' | 'affordability', envelope: string): string {
  return `[experian:${service}] request ${envelope.length}B`;
}
