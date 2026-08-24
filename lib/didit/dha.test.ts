import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callDhaPhotoLookup } from './dha';

// ─── callDhaPhotoLookup — transport layer ───────────────────────────────
//
// Confirms the fail-safe classification: only a connection failure or a
// 5xx becomes `unavailable` (the one outcome that may route to the OCR
// fallback — see dhaVerification.ts). Any other non-2xx becomes
// `request_error`, which never falls back.

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.DIDIT_API_KEY = 'test-api-key';
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('4. dha_call_times_out_falls_back (classified unavailable)', () => {
  it('a fetch rejection (timeout/connection failure) is classified unavailable', async () => {
    global.fetch = vi.fn(async () => { throw new DOMException('The operation was aborted.', 'AbortError'); }) as unknown as typeof fetch;
    const outcome = await callDhaPhotoLookup({ nationalId: '9001015800088', vendorData: 'user-1' });
    expect(outcome.kind).toBe('unavailable');
  });
});

describe('5. dha_call_returns_500_falls_back (classified unavailable)', () => {
  it('an HTTP 500 is classified unavailable', async () => {
    global.fetch = vi.fn(async () => new Response('server on fire', { status: 500 })) as unknown as typeof fetch;
    const outcome = await callDhaPhotoLookup({ nationalId: '9001015800088', vendorData: 'user-1' });
    expect(outcome.kind).toBe('unavailable');
  });
});

describe('a non-5xx, non-2xx response is a request_error, never unavailable', () => {
  it('HTTP 400 is classified request_error', async () => {
    global.fetch = vi.fn(async () => new Response('bad field', { status: 400 })) as unknown as typeof fetch;
    const outcome = await callDhaPhotoLookup({ nationalId: '9001015800088', vendorData: 'user-1' });
    expect(outcome.kind).toBe('request_error');
    if (outcome.kind === 'request_error') expect(outcome.status).toBe(400);
  });

  it('HTTP 401 (bad key) is classified request_error', async () => {
    global.fetch = vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
    const outcome = await callDhaPhotoLookup({ nationalId: '9001015800088', vendorData: 'user-1' });
    expect(outcome.kind).toBe('request_error');
  });
});

describe('request shape', () => {
  it('sends multipart/form-data with issuing_state=ZAF, services=zaf_dha_photo, national_id, consent, vendor_data', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ request_id: 'r1', validations: [] }), { status: 200 }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await callDhaPhotoLookup({ nationalId: '9001015800088', vendorData: 'user-1' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://verification.didit.me/v3/database-validation/');
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get('issuing_state')).toBe('ZAF');
    expect(form.get('services')).toBe('zaf_dha_photo');
    expect(form.get('national_id')).toBe('9001015800088');
    expect(form.get('consent')).toBe('true');
    expect(form.get('vendor_data')).toBe('user-1');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-api-key');
  });

  it('a successful 2xx is classified success and carries the parsed body', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ request_id: 'r1', validations: [{ service_id: 'zaf_dha_photo', outcome_code: 'MATCH' }] }), { status: 200 })) as unknown as typeof fetch;
    const outcome = await callDhaPhotoLookup({ nationalId: '9001015800088', vendorData: 'user-1' });
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.data.validations?.[0].outcome_code).toBe('MATCH');
    }
  });
});
