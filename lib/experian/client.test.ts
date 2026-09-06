import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getScore, parseReturnData, EXPERIAN_ENDPOINTS, type ExperianConfig } from './client';
import { FIXTURES, ERROR_CODES, soapSuccess, soapError, soapFault } from '@/lib/testing/experianFixtures';

// ─── The SOAP transport ────────────────────────────────────────────────
//
// NO NETWORK. Every test here drives a mocked global fetch. The live service
// bills per transaction and every enquiry is logged against a real person's
// credit file, so a test that reached apis.experian.co.za would be both a
// cost and a disclosure.
//
// The envelope tests are REGRESSIONS for bugs that were already found and
// already paid for. Each one cost a billable transaction to discover, and
// each is the kind of thing a tidy-up would happily "fix" back into being
// wrong — so they assert the bytes on the wire, not the shape of the code
// that produced them.

const CFG: ExperianConfig = {
  env: 'uat',
  username: 'test-user',
  password: 'test-pass',
  origin: 'BetterNow',
  pVersion: '4.0',
  timeoutMs: 5_000,
};

/** Bodies captured from the mocked transport, in call order. */
let sent: string[] = [];

function mockTransport(responder: (body: string, call: number) => string | Error) {
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const call = sent.length;
    sent.push(init.body);
    const out = responder(init.body, call);
    if (out instanceof Error) throw out;
    return { ok: true, status: 200, text: async () => out } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => { sent = []; });
afterEach(() => { vi.unstubAllGlobals(); });

/** Contents of a single top-level child of the getScore wrapper. */
function child(body: string, name: string): string | null {
  const m = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : null;
}

describe('the request envelope', () => {
  // ── NAMED TEST (1) ───────────────────────────────────────────────────
  it('uses a PREFIXED namespace on the wrapper and leaves every child unqualified', async () => {
    // The schema declares no elementFormDefault, so it defaults to
    // UNQUALIFIED. Declaring the namespace as a DEFAULT inherits it to all
    // six children, JAX-WS binds none of them, and the server answers -101
    // "Not all variables filled in" — which reads like a missing field rather
    // than a namespace fault. Proven against UAT: default-ns returns -101,
    // prefixed returns -107 with bad credentials, i.e. the parameters bound.
    mockTransport(() => soapSuccess(FIXTURES.real_ss_minimum_risk));
    await getScore('9202204720082', CFG);

    const body = sent[0];
    expect(body).toContain('<ns:getScore xmlns:ns="http://services/">');

    // Adversarial: the default-namespace form must NEVER be produced. This is
    // the assertion that fails if someone "simplifies" the prefix away.
    expect(body).not.toContain('xmlns="http://services/"');

    // And no child carries a namespace of its own — neither a prefix nor a
    // local xmlns attribute.
    for (const name of ['pUsername', 'pPassword', 'pMyOrigin', 'pVersion', 'pResultType', 'pIdNumber']) {
      expect(body, `${name} must be bare`).toContain(`<${name}>`);
      expect(body, `${name} must carry no prefix`).not.toMatch(new RegExp(`<\\w+:${name}[\\s>]`));
      expect(body, `${name} must carry no xmlns`).not.toMatch(new RegExp(`<${name}\\s+[^>]*xmlns`));
    }
  });

  // ── NAMED TEST (2) ───────────────────────────────────────────────────
  it('orders elements by the xs:sequence, not the PDF parameter table', async () => {
    mockTransport(() => soapSuccess(FIXTURES.real_ss_minimum_risk));
    await getScore('9202204720082', CFG);

    const body = sent[0];
    const order = ['pUsername', 'pPassword', 'pMyOrigin', 'pVersion', 'pResultType', 'pIdNumber'];
    const positions = order.map((n) => body.indexOf(`<${n}>`));

    expect(positions.every((p) => p >= 0)).toBe(true);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i], `${order[i]} must follow ${order[i - 1]}`).toBeGreaterThan(positions[i - 1]);
    }

    // The specific inversion the PDF's table would produce: it leads with the
    // ID number and the version, which the schema puts last and fourth.
    expect(body.indexOf('<pIdNumber>')).toBeGreaterThan(body.indexOf('<pUsername>'));
    expect(body.indexOf('<pVersion>')).toBeGreaterThan(body.indexOf('<pMyOrigin>'));
  });

  // ── NAMED TEST (3) ───────────────────────────────────────────────────
  it('sends credentials on EVERY call in a batch, not just the first', async () => {
    // A previous implementation scrubbed the password inside the loop, so
    // call 1 succeeded and calls 2..N came back -101 — which reads as a
    // malformed request rather than as a missing credential, and each failure
    // was billed.
    mockTransport(() => soapSuccess(FIXTURES.real_ss_minimum_risk));

    const ids = ['9202204720082', '9202204720082', '9202204720082', '9202204720082', '9202204720082'];
    for (const id of ids) await getScore(id, CFG);

    expect(sent.length).toBe(ids.length);
    sent.forEach((body, i) => {
      expect(child(body, 'pUsername'), `call ${i + 1} username`).toBe('test-user');
      expect(child(body, 'pPassword'), `call ${i + 1} password`).toBe('test-pass');
      expect(child(body, 'pPassword')?.length, `call ${i + 1} password non-empty`).toBeGreaterThan(0);
    });
  });

  it('sends the configured pVersion, so the env default reaches the wire', async () => {
    mockTransport(() => soapSuccess(FIXTURES.real_ss_minimum_risk));
    await getScore('9202204720082', { ...CFG, pVersion: '4.0' });
    expect(child(sent[0], 'pVersion')).toBe('4.0');
    expect(child(sent[0], 'pResultType')).toBe('json');
  });

  it('posts to the environment it was configured for', async () => {
    const fetchMock = mockTransport(() => soapSuccess(FIXTURES.real_ss_minimum_risk));
    await getScore('9202204720082', { ...CFG, env: 'uat' });
    expect(fetchMock.mock.calls[0][0]).toBe(EXPERIAN_ENDPOINTS.uat);
  });

  // ── NAMED TEST (16), request half ────────────────────────────────────
  it('binds a password containing XML metacharacters', async () => {
    mockTransport(() => soapSuccess(FIXTURES.real_ss_minimum_risk));
    const password = 'p&ss<w"ord';
    await getScore('9202204720082', { ...CFG, password });

    const raw = child(sent[0], 'pPassword');
    // Escaped on the wire...
    expect(raw).toBe('p&amp;ss&lt;w&quot;ord');
    // ...and never raw, which would produce a malformed envelope and a
    // billable -101 rather than an obvious parse failure on our side.
    expect(sent[0]).not.toContain('p&ss<w"ord');
    // The whole body still parses as one well-formed getScore element.
    expect(sent[0]).toContain('</ns:getScore>');
  });
});

describe('response handling', () => {
  it('unwraps returnData, which is a whole JSON document inside a string', async () => {
    mockTransport(() => soapSuccess(FIXTURES.real_su_credit_active));
    const out = await getScore('9202204720082', CFG);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.results[0].resultType).toBe('SU');
    expect(out.results[0].score).toBe(657);
  });

  // ── NAMED TEST (16), response half ───────────────────────────────────
  it('unescapes XML metacharacters inside a reason description', async () => {
    mockTransport(() => soapSuccess(FIXTURES.reason_with_metachars));
    const out = await getScore('9202204720082', CFG);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.results[0].reasons[0].description)
      .toBe('Unsecured Credit & Short Term <loans> indicate "high" risk');
  });

  it('classifies every documented error code', async () => {
    // Grouped by what we should DO, not by numeric range.
    const expected: Record<string, string> = {
      '-101': 'config_error', '-105': 'config_error', '-106': 'provider_error',
      '-107': 'config_error', '-108': 'config_error', '-110': 'config_error',
      '-113': 'input_error', '-114': 'input_error', '-115': 'thin_file',
      '-116': 'config_error', '-999': 'provider_error',
    };
    for (const [code, description] of ERROR_CODES) {
      sent = [];
      mockTransport(() => soapError(code, description));
      const out = await getScore('9202204720082', CFG);
      expect(out.kind, `${code}`).toBe(expected[code]);
      expect(out.kind, `${code} must never be ok`).not.toBe('ok');
      vi.unstubAllGlobals();
    }
  });

  it('reads a SOAP fault as a provider error even though it arrives as HTTP 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      { ok: false, status: 500, text: async () => soapFault } as unknown as Response
    )));
    const out = await getScore('9202204720082', CFG);
    expect(out.kind).toBe('provider_error');
    if (out.kind !== 'provider_error') return;
    expect(out.errorDescription).toBe('Server was unable to process request.');
  });

  it('a non-fault HTTP error is a transport error, not a decision', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      { ok: false, status: 503, text: async () => 'upstream unavailable' } as unknown as Response
    )));
    const out = await getScore('9202204720082', CFG);
    expect(out.kind).toBe('transport_error');
  });

  it('a completed envelope with empty returnData is a provider error, not an empty pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      { ok: true, status: 200, text: async () => soapSuccess('') } as unknown as Response
    )));
    const out = await getScore('9202204720082', CFG);
    expect(out.kind).toBe('provider_error');
  });

  it('does not retry — one envelope, one call', async () => {
    // A returned envelope means Experian processed and billed the
    // transaction. Retrying inside the transport would bill again.
    const fetchMock = mockTransport(() => soapError('-999', 'Unknown Error.'));
    await getScore('9202204720082', CFG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('credentials never escape the transport', () => {
  // ── NAMED TEST (14), forced-error path ───────────────────────────────
  it('a thrown transport failure carries no credential and no request body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ETIMEDOUT 196.0.0.1:443');
    }));

    const out = await getScore('9202204720082', { ...CFG, password: 'sup3r-s3cret-pw' });
    expect(out.kind).toBe('transport_error');

    // The whole outcome, serialised — the shape that would reach a logger or
    // an error reporter. An unredacted SOAP body in a breadcrumb is a
    // cleartext password.
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('sup3r-s3cret-pw');
    expect(serialised).not.toContain('test-user');
    expect(serialised).not.toContain('pPassword');
    expect(serialised).not.toContain('<S:Envelope');
    // The ID is personal information and has no business in an error string either.
    expect(serialised).not.toContain('9202204720082');
  });

  it('an unparseable returnData reports the parse failure without echoing the payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      { ok: true, status: 200, text: async () => soapSuccess('not json at all') } as unknown as Response
    )));
    const out = await getScore('9202204720082', { ...CFG, password: 'sup3r-s3cret-pw' });
    expect(out.kind).toBe('provider_error');
    expect(JSON.stringify(out)).not.toContain('sup3r-s3cret-pw');
  });
});

describe('parser tolerance', () => {
  it('accepts the singular "result" key', () => {
    expect(parseReturnData(FIXTURES.singular_result_key).results.length).toBe(1);
  });

  it('a missing idNumber is null, not a crash', () => {
    expect(parseReturnData(FIXTURES.no_id_echoed).idNumber).toBeNull();
  });

  it('uppercases resultType so selection cannot miss on case', () => {
    const { results } = parseReturnData('{"results":[{"resultType":"su","score":"657","reasons":[]}]}');
    expect(results[0].resultType).toBe('SU');
  });

  it('a non-numeric score becomes null rather than NaN', () => {
    const { results } = parseReturnData('{"results":[{"resultType":"SU","score":"","reasons":[]}]}');
    expect(results[0].score).toBeNull();
  });
});
