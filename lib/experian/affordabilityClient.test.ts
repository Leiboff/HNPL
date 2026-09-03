import { describe, it, expect } from 'vitest';
import {
  buildAffordabilityEnvelope,
  parseAffordabilityResponse,
  affordabilityDispositionFor,
  AFFORDABILITY_ERROR_CODES,
} from './affordabilityClient';
import { redactEnvelope } from './redact';
import * as fx from './__fixtures__/affordability';

const base = {
  username: 'user', password: 'pass', origin: 'BetterNow',
  originVersion: '1.0', requestVersion: '1.0', outputFormat: 'json',
  idNumber: fx.FIXTURE_ID,
};

// ─── The envelope ───────────────────────────────────────────────────────

describe('buildAffordabilityEnvelope', () => {
  const envelope = buildAffordabilityEnvelope(base);

  it('uses the affordability namespace, not the score one', () => {
    expect(envelope).toContain('<ns:DoAffordability xmlns:ns="http://webServices/">');
    expect(envelope).not.toContain('http://services/');
  });

  it('wraps every parameter in a single <request> element', () => {
    // Flat children do not bind here — that is the score service's shape.
    expect(envelope).toContain('<request>');
    expect(envelope).toMatch(/<request>\s*<pUsername>/);
  });

  it('leaves the children unqualified — the schema has no elementFormDefault', () => {
    expect(envelope).not.toMatch(/<ns:p[A-Z]/);
  });

  it('sends the xs:sequence in the exact documented order', () => {
    const order = [...envelope.matchAll(/<(p[A-Za-z]+)>/g)].map((m) => m[1]);
    expect(order).toEqual([
      'pUsername', 'pPassword', 'pOrigin', 'pOriginVersion', 'pRequestVersion',
      'pOutputFormat', 'pIdNumber', 'pName', 'pSurname',
      'pGrossIncomeAmount', 'pNetIncomeAmount', 'pLivingExpenses',
    ]);
  });

  it('omits only pPrimarySpouseEnquiryId, the one optional element', () => {
    expect(envelope).not.toContain('pPrimarySpouseEnquiryId');
    const withSpouse = buildAffordabilityEnvelope({ ...base, primarySpouseEnquiryId: 'ENQ-9' });
    expect(withSpouse).toContain('<pPrimarySpouseEnquiryId>ENQ-9</pPrimarySpouseEnquiryId>');
  });
});

// ─── The reason the income fields exist and stay empty ──────────────────

describe('income is never sent — it would suppress the GMIP prediction', () => {
  it('the three income elements are present and empty', () => {
    // Present because the schema requires them; empty because a supplied
    // figure makes Experian calculate against the patient's own number
    // instead of predicting one, which defeats the purpose of the call.
    const envelope = buildAffordabilityEnvelope(base);
    expect(envelope).toContain('<pGrossIncomeAmount></pGrossIncomeAmount>');
    expect(envelope).toContain('<pNetIncomeAmount></pNetIncomeAmount>');
    expect(envelope).toContain('<pLivingExpenses></pLivingExpenses>');
  });

  it('the builder accepts no income argument at all', () => {
    // Structural, not conventional: there is no parameter to pass a
    // declared figure through, so one cannot be sent by mistake. If a
    // future edit adds such a parameter, this fails.
    const params = Object.keys(base);
    expect(params).not.toContain('grossIncome');
    expect(params).not.toContain('declaredIncome');

    // Any extra property is ignored by the builder rather than emitted.
    const sneaky = buildAffordabilityEnvelope({
      ...base,
      // @ts-expect-error there is deliberately no income parameter on this builder
      pGrossIncomeAmount: '999999',
    });
    expect(sneaky).toContain('<pGrossIncomeAmount></pGrossIncomeAmount>');
    expect(sneaky).not.toContain('999999');
  });

  it('a name is sent empty rather than omitted when unknown', () => {
    const envelope = buildAffordabilityEnvelope(base);
    expect(envelope).toContain('<pName></pName>');
    expect(envelope).toContain('<pSurname></pSurname>');
  });
});

// ─── Parsing ────────────────────────────────────────────────────────────

describe('retData needs two parses', () => {
  it('reads a double-encoded payload', () => {
    const parsed = parseAffordabilityResponse(fx.AFFORD_SUCCESS_HIGH);
    expect(parsed.kind).toBe('data');
    if (parsed.kind !== 'data') return;
    expect(parsed.data.gmipValue).toBe(30_000);
    expect(parsed.data.gmipConfidenceLevel).toBe('High');
    expect(parsed.data.bureauExpenses).toBe(2_000);
    expect(parsed.data.calcLivingExpenses).toBe(6_000);
    expect(parsed.data.enqId).toBe('ENQ-1000001');
  });

  it('also reads a single-encoded payload', () => {
    const parsed = parseAffordabilityResponse(fx.AFFORD_SUCCESS_HIGH_SINGLE);
    expect(parsed.kind === 'data' && parsed.data.gmipValue).toBe(30_000);
  });

  it('keeps Experian\'s own Disposable_Income unmodified', () => {
    // Stored alongside our figure, never in place of it: if a cohort goes
    // bad we need to see whether the bureau saw it coming.
    const parsed = parseAffordabilityResponse(fx.AFFORD_SUCCESS_HIGH);
    expect(parsed.kind === 'data' && parsed.data.disposableIncome).toBe(17_200);
  });

  it('keeps the whole raw payload for the assessment log', () => {
    const parsed = parseAffordabilityResponse(fx.AFFORD_SUCCESS_HIGH);
    expect(parsed.kind === 'data' && parsed.data.raw).toMatchObject({ GMIP_Band: 'R25 001 - R35 000' });
  });

  it('reads "Unable To Determine GMIP" as data, not an error', () => {
    const parsed = parseAffordabilityResponse(fx.AFFORD_SUCCESS_UNABLE);
    expect(parsed.kind).toBe('data');
    if (parsed.kind !== 'data') return;
    expect(parsed.data.gmipConfidenceLevel).toBe('Unable To Determine GMIP');
    expect(parsed.data.gmipValue).toBeNull();
  });

  it('turns blank numerics into null rather than zero', () => {
    // A zero income is a very different claim from an absent one, and
    // would flow into the formula as a real number.
    const parsed = parseAffordabilityResponse(fx.AFFORD_SUCCESS_UNABLE);
    expect(parsed.kind === 'data' && parsed.data.gmipValue).toBeNull();
    expect(parsed.kind === 'data' && parsed.data.gmipValue).not.toBe(0);
  });
});

// ─── Error codes: this service's table, not the other one's ─────────────

describe('affordability error codes', () => {
  it.each([
    ['-209', fx.AFFORD_ERROR_209_NO_GMIP],
    ['-217', fx.AFFORD_ERROR_217_NO_RECORD],
  ])('%s is thin-file treatment', (code, xml) => {
    expect(parseAffordabilityResponse(xml)).toMatchObject({
      kind: 'error_code', code, disposition: 'thin_file',
    });
  });

  it.each([
    ['-205', fx.AFFORD_ERROR_205_NOT_ACTIVATED],
    ['-207', fx.AFFORD_ERROR_207_INVALID_ID],
    ['-201', fx.AFFORD_ERROR_201_NOT_BINDING],
  ])('%s alerts rather than declining', (code, xml) => {
    expect(parseAffordabilityResponse(xml)).toMatchObject({
      kind: 'error_code', code, disposition: 'alert',
    });
  });

  it('-204 is transient and retryable', () => {
    expect(parseAffordabilityResponse(fx.AFFORD_ERROR_204_GENERIC)).toMatchObject({
      kind: 'error_code', code: '-204', disposition: 'retry',
    });
  });

  it('an undocumented code alerts rather than declining', () => {
    expect(parseAffordabilityResponse(fx.AFFORD_ERROR_UNDOCUMENTED)).toMatchObject({
      kind: 'error_code', disposition: 'alert',
    });
  });

  it('the two services do not share an error table', () => {
    // -115 is a real getScore code (thin file). It has no meaning here, and
    // must not be silently borrowed from the other service's table.
    expect(affordabilityDispositionFor('-115').disposition).toBe('alert');
    expect(Object.keys(AFFORDABILITY_ERROR_CODES)).not.toContain('-115');
  });

  it('no error code declines an applicant', () => {
    for (const [code, spec] of Object.entries(AFFORDABILITY_ERROR_CODES)) {
      expect(['thin_file', 'retry', 'alert'], code).toContain(spec.disposition);
    }
  });
});

// ─── Faults ─────────────────────────────────────────────────────────────

describe('faults and junk resolve to unavailable', () => {
  it('reads the unmarshalling faultstring out of a 500 body', () => {
    const parsed = parseAffordabilityResponse(fx.AFFORD_SOAP_FAULT_500);
    expect(parsed.kind).toBe('unavailable');
    // The decoded entity proves the fault text survived XML decoding —
    // this is the message a flat, unwrapped request produces.
    expect(parsed.kind === 'unavailable' && parsed.detail).toContain('<{}request>');
  });

  it('a non-XML body is unavailable, not a crash', () => {
    expect(parseAffordabilityResponse(fx.AFFORD_GARBAGE_BODY).kind).toBe('unavailable');
  });

  it('unparseable retData is unavailable', () => {
    const broken = fx.AFFORD_SUCCESS_HIGH.replace(
      /<retData>[\s\S]*?<\/retData>/, '<retData>{{{</retData>');
    expect(parseAffordabilityResponse(broken).kind).toBe('unavailable');
  });
});

// ─── Redaction applies here too ─────────────────────────────────────────

describe('the affordability envelope redacts the same way', () => {
  it('strips credentials and masks the ID', () => {
    const safe = redactEnvelope(buildAffordabilityEnvelope({
      ...base, username: 'svc_user', password: 'hunter2',
    }));
    expect(safe).not.toContain('hunter2');
    expect(safe).not.toContain('svc_user');
    expect(safe).not.toContain(fx.FIXTURE_ID);
    expect(safe).toContain('[REDACTED]');
  });
});
