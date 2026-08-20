import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Datanamix FaceTec client contract ──────────────────────────────────
//
// Mocks global fetch to assert the exact wire shape (Basic auth header,
// X-User-Agent forwarding, JSON body) without a real HTTP call, and that
// every failure path returns { ok:false } rather than throwing.

const originalFetch = global.fetch;
const originalEnv   = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env  = { ...originalEnv };
});

async function load() {
  return import('./datanamixClient');
}

function setCreds() {
  process.env.FACETEC_API_USERNAME = 'test-user';
  process.env.FACETEC_API_PASSWORD = 'test-pass';
}

describe('credentials guard', () => {
  it('is a documented no-op when FACETEC_API_USERNAME is missing', async () => {
    delete process.env.FACETEC_API_USERNAME;
    process.env.FACETEC_API_PASSWORD = 'x';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const { getFaceTecSessionToken } = await load();
    const result = await getFaceTecSessionToken('agent-string');

    expect(result).toEqual({ ok: false, error: 'facetec_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('is a no-op when FACETEC_API_PASSWORD is missing', async () => {
    process.env.FACETEC_API_USERNAME = 'id';
    delete process.env.FACETEC_API_PASSWORD;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const { postLiveness3d } = await load();
    const result = await postLiveness3d({
      faceScan: 'a', auditTrailImage: 'b', lowQualityAuditTrailImage: 'c', xUserAgent: 'ua',
    });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getFaceTecSessionToken — request shape', () => {
  beforeEach(setCreds);

  it('GETs /session-token with Basic auth + forwarded X-User-Agent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, sessionToken: 'abc123' }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { getFaceTecSessionToken } = await load();
    const result = await getFaceTecSessionToken('device-sdk-user-agent-string');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://face.datanamix.com/v9/session-token');
    const headers = init.headers as Record<string, string>;
    // base64("test-user:test-pass") = dGVzdC11c2VyOnRlc3QtcGFzcw==
    expect(headers.Authorization).toBe('Basic dGVzdC11c2VyOnRlc3QtcGFzcw==');
    expect(headers['X-User-Agent']).toBe('device-sdk-user-agent-string');
    expect(result).toEqual({ ok: true, sessionToken: 'abc123' });
  });

  it('respects FACETEC_API_BASE_URL when set', async () => {
    process.env.FACETEC_API_BASE_URL = 'https://sandbox.face.datanamix.com/v9';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, sessionToken: 'x' }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { getFaceTecSessionToken } = await load();
    await getFaceTecSessionToken('ua');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://sandbox.face.datanamix.com/v9/session-token');
  });

  it('treats success:false as a failure even on HTTP 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { getFaceTecSessionToken } = await load();
    const result = await getFaceTecSessionToken('ua');
    expect(result).toEqual({ ok: false, error: 'facetec_session_token_failed' });
  });
});

describe('postLiveness3d — request shape', () => {
  beforeEach(setCreds);

  it('POSTs faceScan/auditTrailImage/lowQualityAuditTrailImage as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { postLiveness3d } = await load();
    const result = await postLiveness3d({
      faceScan:                  'FACESCAN_B64',
      auditTrailImage:           'AUDIT_B64',
      lowQualityAuditTrailImage: 'LOWQ_B64',
      xUserAgent:                'ua-string',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://face.datanamix.com/v9/liveness-3d');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      faceScan:                  'FACESCAN_B64',
      auditTrailImage:           'AUDIT_B64',
      lowQualityAuditTrailImage: 'LOWQ_B64',
    });
    expect(result).toEqual({ ok: true, success: true });
  });

  it('a real (non-spoof) FaceScan that Datanamix rejects returns success:false, not an error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, ageEstimateGroupEnumInt: 2 }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { postLiveness3d } = await load();
    const result = await postLiveness3d({
      faceScan: 'a', auditTrailImage: 'b', lowQualityAuditTrailImage: 'c', xUserAgent: 'ua',
    });
    expect(result).toEqual({ ok: true, success: false });
  });
});

describe('failure paths return { ok:false }, never throw', () => {
  beforeEach(setCreds);

  it('non-2xx response maps to { ok:false, error: facetec_provider_<status> }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { getFaceTecSessionToken } = await load();
    const result = await getFaceTecSessionToken('ua');
    expect(result).toEqual({ ok: false, error: 'facetec_provider_500' });
  });

  it('Status:Failure in the payload (e.g. bad Basic Auth) maps to facetec_auth_failed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ Status: 'Failure', Error: 'Authentication Failed' }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { getFaceTecSessionToken } = await load();
    const result = await getFaceTecSessionToken('ua');
    expect(result).toEqual({ ok: false, error: 'facetec_auth_failed' });
  });

  it('AbortError (timeout) returns { ok:false, error: facetec_timeout } — does not throw', async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      const e = new Error('aborted');
      Object.assign(e, { name: 'AbortError' });
      return Promise.reject(e);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { postLiveness3d } = await load();
    const result = await postLiveness3d({
      faceScan: 'a', auditTrailImage: 'b', lowQualityAuditTrailImage: 'c', xUserAgent: 'ua',
    });
    expect(result).toEqual({ ok: false, error: 'facetec_timeout' });
  });

  it('generic network error returns { ok:false, error: facetec_network }', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { getFaceTecSessionToken } = await load();
    const result = await getFaceTecSessionToken('ua');
    expect(result).toEqual({ ok: false, error: 'facetec_network' });
  });
});

describe('getFaceTecBrowserSdkKeys — combines the three license endpoints', () => {
  beforeEach(setCreds);

  it('fetches device key, public key, and production key in parallel and caches the result', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/device-license-key')) {
        return Promise.resolve(new Response(JSON.stringify({ Status: 'success', DeviceLicenseKey: 'DEVICE_KEY' }), { status: 200 }));
      }
      if (url.endsWith('/public-face-map-encryption-key')) {
        return Promise.resolve(new Response(JSON.stringify({ Status: 'success', PublicFaceMapEncryptionKey: 'PUBLIC_KEY' }), { status: 200 }));
      }
      if (url.endsWith('/production-keys')) {
        return Promise.resolve(new Response(JSON.stringify({ Status: 'success', ProductionKeys: { key: 'PROD_KEY', domains: '', expiryDate: '2030-01-01' } }), { status: 200 }));
      }
      throw new Error(`unexpected url ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { getFaceTecBrowserSdkKeys } = await load();
    const result = await getFaceTecBrowserSdkKeys();
    expect(result).toEqual({
      ok:   true,
      data: {
        deviceKeyIdentifier:        'DEVICE_KEY',
        publicFaceMapEncryptionKey: 'PUBLIC_KEY',
        productionKeyText:          'PROD_KEY',
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Second call within the TTL window is served from cache — no new fetches.
    fetchMock.mockClear();
    const second = await getFaceTecBrowserSdkKeys();
    expect(second).toEqual(result);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails cleanly when a license response is missing an expected field', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/device-license-key')) {
        return Promise.resolve(new Response(JSON.stringify({ Status: 'success' }), { status: 200 })); // no DeviceLicenseKey
      }
      return Promise.resolve(new Response(JSON.stringify({ Status: 'success', PublicFaceMapEncryptionKey: 'x', ProductionKeys: { key: 'y' } }), { status: 200 }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { getFaceTecBrowserSdkKeys } = await load();
    const result = await getFaceTecBrowserSdkKeys();
    expect(result).toEqual({ ok: false, error: 'facetec_bad_license_response' });
  });
});

describe('FACETEC_FETCH_TIMEOUT_MS', () => {
  it('is the bounded-fetch ceiling (longer than the 8s SMS/email default — FaceScan payloads are bigger)', async () => {
    const { FACETEC_FETCH_TIMEOUT_MS } = await load();
    expect(FACETEC_FETCH_TIMEOUT_MS).toBe(15_000);
  });
});
