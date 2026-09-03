import { describe, it, expect } from 'vitest';
import {
  parseGetScoreResponse,
  buildGetScoreEnvelope,
  dispositionFor,
  SCORE_ERROR_CODES,
} from './scoreClient';
import { redactEnvelope, maskIdsInText } from './redact';
import { extractTag, xmlEscape, xmlDecode, isSoapFault } from './soap';
import * as fx from './__fixtures__/score';

// ─── The live capture is the reference ──────────────────────────────────

describe('the captured UAT reply parses', () => {
  const parsed = parseGetScoreResponse(fx.SCORE_SUCCESS_SU_UNSCORABLE_STS_620);

  it('yields both scorecards', () => {
    expect(parsed.kind).toBe('results');
    if (parsed.kind !== 'results') return;
    expect(parsed.idNumber).toBe(fx.FIXTURE_ID);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]).toMatchObject({ resultType: 'SU', score: '-1' });
    expect(parsed.results[1]).toMatchObject({ resultType: 'STS', score: '620' });
  });

  it('keeps the reason codes attached to the card that reported them', () => {
    if (parsed.kind !== 'results') return;
    expect(parsed.results[0].reasons[0]).toMatchObject({ reasonCode: 'MI62' });
    expect(parsed.results[1].reasons).toEqual([]);
  });

  it('an EMPTY errorCode is success, not a failure', () => {
    // The convention is empty-string-on-success rather than "0". Treating a
    // present-but-empty errorCode as an error fails every good call.
    expect(extractTag(fx.SCORE_SUCCESS_SU_UNSCORABLE_STS_620, 'errorCode')).toBe('');
    expect(parsed.kind).toBe('results');
  });

  it('does not depend on hasErrors, which the live reply omits', () => {
    expect(fx.SCORE_SUCCESS_SU_UNSCORABLE_STS_620).not.toContain('hasErrors');
    expect(parsed.kind).toBe('results');
  });
});

// ─── Coded errors ───────────────────────────────────────────────────────

describe('error codes map to dispositions, and only one is patient-facing', () => {
  it('-115 is thin-file treatment', () => {
    const parsed = parseGetScoreResponse(fx.SCORE_ERROR_115_THIN_FILE);
    expect(parsed).toMatchObject({ kind: 'error_code', code: '-115', disposition: 'thin_file' });
  });

  it.each([
    ['-107', fx.SCORE_ERROR_107_BAD_CREDENTIALS],
    ['-101', fx.SCORE_ERROR_101_NOT_BOUND],
    ['-110', fx.SCORE_ERROR_110_BRANCH_OFF],
    ['-114', fx.SCORE_ERROR_114_INVALID_ID],
  ])('%s alerts rather than declining', (code, xml) => {
    const parsed = parseGetScoreResponse(xml);
    expect(parsed).toMatchObject({ kind: 'error_code', code, disposition: 'alert' });
  });

  it.each([
    ['-106', fx.SCORE_ERROR_106_TRANSIENT],
    ['-999', fx.SCORE_ERROR_999_UNKNOWN],
  ])('%s is transient and retryable', (code, xml) => {
    expect(parseGetScoreResponse(xml)).toMatchObject({
      kind: 'error_code', code, disposition: 'retry',
    });
  });

  it('an undocumented code alerts — we never refuse on an answer we cannot read', () => {
    const parsed = parseGetScoreResponse(fx.SCORE_ERROR_UNDOCUMENTED);
    expect(parsed).toMatchObject({ kind: 'error_code', disposition: 'alert' });
  });

  it('no error code in the table declines an applicant', () => {
    // Only 'thin_file' has any effect on the applicant's outcome, and that
    // effect is a grant. Everything else is pending.
    for (const [code, spec] of Object.entries(SCORE_ERROR_CODES)) {
      expect(['thin_file', 'retry', 'alert'], code).toContain(spec.disposition);
    }
  });

  it('dispositionFor tolerates whitespace', () => {
    expect(dispositionFor(' -115 ').disposition).toBe('thin_file');
  });
});

// ─── Faults and junk ────────────────────────────────────────────────────

describe('a fault is unavailable, never a decline', () => {
  it('reads faultstring out of the 500 body', () => {
    expect(isSoapFault(fx.SCORE_SOAP_FAULT_500)).toBe(true);
    const parsed = parseGetScoreResponse(fx.SCORE_SOAP_FAULT_500);
    expect(parsed.kind).toBe('unavailable');
    expect(parsed.kind === 'unavailable' && parsed.detail)
      .toContain('Cannot find dispatch method');
  });

  it('masks an ID echoed back inside a fault string', () => {
    const parsed = parseGetScoreResponse(fx.SCORE_SOAP_FAULT_WITH_ID);
    expect(parsed.kind === 'unavailable' && parsed.detail).not.toContain(fx.FIXTURE_ID);
    expect(parsed.kind === 'unavailable' && parsed.detail).toContain('7080');
  });

  it('an HTML error page is unavailable rather than a parse crash', () => {
    expect(parseGetScoreResponse(fx.SCORE_HTML_ERROR_PAGE).kind).toBe('unavailable');
  });

  it('a reply with unparseable returnData is unavailable', () => {
    const broken = fx.SCORE_SUCCESS_SU_UNSCORABLE_STS_620
      .replace(/<returnData>[\s\S]*?<\/returnData>/, '<returnData>{not json</returnData>');
    expect(parseGetScoreResponse(broken).kind).toBe('unavailable');
  });

  it('a reply with an empty results array is unavailable, not a thin file', () => {
    expect(parseGetScoreResponse(fx.scoreReplyWith([])).kind).toBe('unavailable');
  });
});

// ─── The envelope ───────────────────────────────────────────────────────

describe('buildGetScoreEnvelope matches the captured request', () => {
  const envelope = buildGetScoreEnvelope({
    username: 'user', password: 'pass', origin: 'BetterNow',
    version: '4.0', resultType: 'json', idNumber: fx.FIXTURE_ID,
  });

  it('calls the getScore operation in the http://services/ namespace', () => {
    expect(envelope).toContain('<ns:getScore xmlns:ns="http://services/">');
    // NOT the affordability namespace, and NOT the URL path spelling.
    expect(envelope).not.toContain('http://webServices/');
    expect(envelope).not.toContain('<ns:GetPersonScore');
  });

  it('sends parameters FLAT — no <request> wrapper', () => {
    // The wrapper is the affordability service's shape. Sending it here
    // does not bind and returns -101.
    expect(envelope).not.toContain('<request>');
    expect(envelope).toMatch(/<ns:getScore[^>]*>\s*<pUsername>/);
  });

  it('uses this service\'s element names, not the affordability ones', () => {
    expect(envelope).toContain('<pMyOrigin>BetterNow</pMyOrigin>');
    expect(envelope).toContain('<pVersion>4.0</pVersion>');
    expect(envelope).toContain('<pResultType>json</pResultType>');
    expect(envelope).not.toContain('<pOrigin>');
    expect(envelope).not.toContain('<pRequestVersion>');
    expect(envelope).not.toContain('<pOutputFormat>');
  });

  it('sends the six parameters in the captured order', () => {
    const order = [...envelope.matchAll(/<(p[A-Za-z]+)>/g)].map((m) => m[1]);
    expect(order).toEqual([
      'pUsername', 'pPassword', 'pMyOrigin', 'pVersion', 'pResultType', 'pIdNumber',
    ]);
  });

  it('omits the enquiry-type element entirely when unset', () => {
    // An element the schema does not expect is how -101 happens. There is
    // no enquiry-type parameter on this operation today.
    expect(envelope).not.toContain('pEnquiryType');
  });

  it('includes it only when explicitly configured', () => {
    const withType = buildGetScoreEnvelope({
      username: 'u', password: 'p', origin: 'o', version: '4.0',
      resultType: 'json', idNumber: fx.FIXTURE_ID, enquiryType: 'PRELIMINARY',
    });
    expect(withType).toContain('<pEnquiryType>PRELIMINARY</pEnquiryType>');
  });

  it('escapes credentials so a password containing & cannot break the XML', () => {
    const escaped = buildGetScoreEnvelope({
      username: 'a&b', password: 'p<>"\'&', origin: 'o', version: '4.0',
      resultType: 'json', idNumber: fx.FIXTURE_ID,
    });
    expect(escaped).toContain('<pUsername>a&amp;b</pUsername>');
    expect(escaped).toContain('&lt;');
    expect(escaped).not.toMatch(/<pPassword>[^<]*<[^/]/);
  });
});

// ─── Credentials must never reach a log ─────────────────────────────────

describe('redaction', () => {
  const envelope = buildGetScoreEnvelope({
    username: 'svc_betternow', password: 'sup3r-s3cret', origin: 'BetterNow',
    version: '4.0', resultType: 'json', idNumber: fx.FIXTURE_ID,
  });

  it('removes the password and the username entirely', () => {
    const safe = redactEnvelope(envelope);
    expect(safe).not.toContain('sup3r-s3cret');
    expect(safe).not.toContain('svc_betternow');
    expect(safe).toContain('[REDACTED]');
  });

  it('does not preserve the password length', () => {
    const short = redactEnvelope(buildGetScoreEnvelope({
      username: 'u', password: 'a', origin: 'o', version: '4.0',
      resultType: 'json', idNumber: fx.FIXTURE_ID,
    }));
    const long = redactEnvelope(buildGetScoreEnvelope({
      username: 'u', password: 'a'.repeat(64), origin: 'o', version: '4.0',
      resultType: 'json', idNumber: fx.FIXTURE_ID,
    }));
    expect(short).toBe(long);
  });

  it('masks the ID number to its last four digits', () => {
    const safe = redactEnvelope(envelope);
    expect(safe).not.toContain(fx.FIXTURE_ID);
    expect(safe).toContain('7080');
    // The first six digits are a date of birth and must not survive.
    expect(safe).not.toContain('740828');
  });

  it('masks IDs in free text too', () => {
    expect(maskIdsInText(`lookup failed for ${fx.FIXTURE_ID} at 10:04`))
      .not.toContain(fx.FIXTURE_ID);
  });

  it('returns a placeholder rather than empty for nullish input', () => {
    expect(redactEnvelope(null)).toBe('<empty>');
    expect(redactEnvelope('')).toBe('<empty>');
  });
});

// ─── XML plumbing ───────────────────────────────────────────────────────

describe('xml helpers', () => {
  it('extractTag ignores namespace prefixes', () => {
    expect(extractTag('<ns2:foo>bar</ns2:foo>', 'foo')).toBe('bar');
    expect(extractTag('<foo>bar</foo>', 'foo')).toBe('bar');
  });

  it('distinguishes an absent element from an empty one', () => {
    // errorCode is empty on success; conflating the two breaks every call.
    expect(extractTag('<a></a>', 'errorCode')).toBeNull();
    expect(extractTag('<errorCode></errorCode>', 'errorCode')).toBe('');
    expect(extractTag('<errorCode/>', 'errorCode')).toBe('');
  });

  it('decodes entities, ampersand last', () => {
    expect(xmlDecode('&amp;lt;')).toBe('&lt;');
    expect(xmlDecode('&lt;tag&gt;')).toBe('<tag>');
    expect(xmlDecode('&#65;&#x42;')).toBe('AB');
  });

  it('escape and decode round-trip', () => {
    const raw = `a&b<c>"d"'e'`;
    expect(xmlDecode(xmlEscape(raw))).toBe(raw);
  });
});
