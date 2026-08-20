import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── FaceTec relay contract ──────────────────────────────────────────────
//
// Mocks global fetch to assert the exact wire shape (configured URL, auth
// header, { requestBlob } body) without a real HTTP call, and that every
// failure path returns { ok:false } rather than throwing. The relay never
// inspects requestBlob/responseBlob contents — it's opaque both ways.

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
  return import('./relay');
}

function setConfig() {
  process.env.FACETEC_RELAY_API_URL = 'https://relay.example.com/process-request';
  process.env.FACETEC_RELAY_API_KEY = 'test-relay-key';
}

describe('config guard', () => {
  it('is a documented no-op when FACETEC_RELAY_API_URL is missing', async () => {
    delete process.env.FACETEC_RELAY_API_URL;
    process.env.FACETEC_RELAY_API_KEY = 'x';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const { relayFaceTecRequest } = await load();
    const result = await relayFaceTecRequest('BLOB');

    expect(result).toEqual({ ok: false, error: 'facetec_relay_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('is a no-op when FACETEC_RELAY_API_KEY is missing', async () => {
    process.env.FACETEC_RELAY_API_URL = 'https://relay.example.com';
    delete process.env.FACETEC_RELAY_API_KEY;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const { relayFaceTecRequest } = await load();
    const result = await relayFaceTecRequest('BLOB');
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('relayFaceTecRequest — request shape', () => {
  beforeEach(setConfig);

  it('POSTs { requestBlob } with the configured URL and default X-Api-Key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ responseBlob: 'RESPONSE_BLOB' }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { relayFaceTecRequest } = await load();
    const result = await relayFaceTecRequest('REQUEST_BLOB');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://relay.example.com/process-request');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('test-relay-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ requestBlob: 'REQUEST_BLOB' });
    expect(result).toEqual({ ok: true, responseBlob: 'RESPONSE_BLOB', result: null });
  });

  it('uses FACETEC_RELAY_AUTH_HEADER_NAME when set', async () => {
    process.env.FACETEC_RELAY_AUTH_HEADER_NAME = 'Authorization';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ responseBlob: 'X' }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { relayFaceTecRequest } = await load();
    await relayFaceTecRequest('BLOB');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('test-relay-key');
    expect(headers['X-Api-Key']).toBeUndefined();
  });

  it('passes through the optional result object unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ responseBlob: 'X', result: { wasProcessed: true, foo: 'bar' } }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { relayFaceTecRequest } = await load();
    const result = await relayFaceTecRequest('BLOB');
    expect(result).toEqual({ ok: true, responseBlob: 'X', result: { wasProcessed: true, foo: 'bar' } });
  });
});

describe('failure paths return { ok:false }, never throw', () => {
  beforeEach(setConfig);

  it('non-2xx response maps to { ok:false, error: facetec_relay_<status> }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 502 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { relayFaceTecRequest } = await load();
    const result = await relayFaceTecRequest('BLOB');
    expect(result).toEqual({ ok: false, error: 'facetec_relay_502' });
  });

  it('a 200 with no responseBlob field is treated as malformed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { relayFaceTecRequest } = await load();
    const result = await relayFaceTecRequest('BLOB');
    expect(result).toEqual({ ok: false, error: 'facetec_relay_200' });
  });

  it('AbortError (timeout) returns { ok:false, error: facetec_relay_timeout } — does not throw', async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      const e = new Error('aborted');
      Object.assign(e, { name: 'AbortError' });
      return Promise.reject(e);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { relayFaceTecRequest } = await load();
    const result = await relayFaceTecRequest('BLOB');
    expect(result).toEqual({ ok: false, error: 'facetec_relay_timeout' });
  });

  it('generic network error returns { ok:false, error: facetec_relay_network }', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { relayFaceTecRequest } = await load();
    const result = await relayFaceTecRequest('BLOB');
    expect(result).toEqual({ ok: false, error: 'facetec_relay_network' });
  });
});

describe('FACETEC_RELAY_TIMEOUT_MS', () => {
  it('is the bounded-fetch ceiling', async () => {
    const { FACETEC_RELAY_TIMEOUT_MS } = await load();
    expect(FACETEC_RELAY_TIMEOUT_MS).toBe(15_000);
  });
});
