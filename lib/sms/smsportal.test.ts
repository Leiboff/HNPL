import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── SMSPortal sender contract ──────────────────────────────────────────
//
// We mock global fetch so we can assert the exact wire shape (Basic
// auth header, JSON body, testMode flag) without making a real HTTP
// call. Also verifies the bounded-fetch discipline — an 8s timeout
// must NOT propagate as a thrown rejection up the call chain.

const originalFetch = global.fetch;
const originalEnv   = { ...process.env };

beforeEach(() => {
  // Clean env between tests so a leaking creds value doesn't bleed.
  process.env = { ...originalEnv };
  // Reset the module-scoped warnedMissingCreds — re-import via
  // dynamic import so each test gets a fresh module instance.
  vi.resetModules();
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env  = { ...originalEnv };
});

async function load() {
  return (await import('./smsportal'));
}

describe('sendSms — credentials guard', () => {
  it('is a documented no-op when SMSPORTAL_CLIENT_ID is missing', async () => {
    delete process.env.SMSPORTAL_CLIENT_ID;
    process.env.SMSPORTAL_CLIENT_SECRET = 'x';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const { sendSms } = await load();
    const result = await sendSms('+27821234567', 'Your BetterNow code is 123456…');

    expect(result).toEqual({ ok: false, error: 'sms_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is a no-op when SMSPORTAL_CLIENT_SECRET is missing', async () => {
    process.env.SMSPORTAL_CLIENT_ID = 'id';
    delete process.env.SMSPORTAL_CLIENT_SECRET;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { sendSms } = await load();
    const result = await sendSms('+27821234567', 'body');
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendSms — request shape', () => {
  beforeEach(() => {
    process.env.SMSPORTAL_CLIENT_ID     = 'test-client-id';
    process.env.SMSPORTAL_CLIENT_SECRET = 'test-client-secret';
  });

  it('POSTs to /bulkmessages with the right Basic auth header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { sendSms } = await load();
    await sendSms('+27821234567', 'Your BetterNow code is 482165. It expires in 10 minutes.');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://rest.smsportal.com/bulkmessages');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    // base64("test-client-id:test-client-secret") = dGVzdC1jbGllbnQtaWQ6dGVzdC1jbGllbnQtc2VjcmV0
    expect(headers.Authorization).toBe('Basic dGVzdC1jbGllbnQtaWQ6dGVzdC1jbGllbnQtc2VjcmV0');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('sends a messages array with content + destination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { sendSms } = await load();
    await sendSms('+27821234567', 'hello');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe('hello');
    expect(body.messages[0].destination).toBe('+27821234567');
  });

  it('includes testMode:true when SMS_TEST_MODE=true env is set', async () => {
    process.env.SMS_TEST_MODE = 'true';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { sendSms } = await load();
    await sendSms('+27821234567', 'hello');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.testMode).toBe(true);
  });

  it('OMITS testMode key when SMS_TEST_MODE is unset (production default)', async () => {
    delete process.env.SMS_TEST_MODE;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { sendSms } = await load();
    await sendSms('+27821234567', 'hello');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect('testMode' in body).toBe(false);
  });

  it('attaches the sender ID when SMSPORTAL_SENDER_ID is set', async () => {
    process.env.SMSPORTAL_SENDER_ID = 'BETTERNOW';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { sendSms } = await load();
    await sendSms('+27821234567', 'hello');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].from).toBe('BETTERNOW');
  });
});

describe('sendSms — failure paths return { ok:false }, never throw', () => {
  beforeEach(() => {
    process.env.SMSPORTAL_CLIENT_ID     = 'id';
    process.env.SMSPORTAL_CLIENT_SECRET = 'secret';
  });

  it('non-2xx response maps to { ok:false, error: sms_provider_<status> }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('quota exceeded', { status: 402 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { sendSms } = await load();
    const result = await sendSms('+27821234567', 'hello');
    expect(result).toEqual({ ok: false, error: 'sms_provider_402' });
  });

  it('AbortError (timeout) returns { ok:false, error: sms_timeout } — does not throw', async () => {
    // Simulate the fetch rejecting with an AbortError (what
    // controller.abort() triggers).
    const fetchMock = vi.fn().mockImplementation(() => {
      const e = new Error('aborted');
      Object.assign(e, { name: 'AbortError' });
      return Promise.reject(e);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { sendSms } = await load();
    const result = await sendSms('+27821234567', 'hello');
    expect(result).toEqual({ ok: false, error: 'sms_timeout' });
  });

  it('generic network error returns { ok:false, error: sms_network }', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { sendSms } = await load();
    const result = await sendSms('+27821234567', 'hello');
    expect(result).toEqual({ ok: false, error: 'sms_network' });
  });
});

describe('buildOtpSmsBody', () => {
  it('formats the OTP body with the autofill-triggering "code is N" phrasing', async () => {
    const { buildOtpSmsBody } = await load();
    expect(buildOtpSmsBody('482165')).toBe(
      'Your BetterNow code is 482165. It expires in 10 minutes.',
    );
  });

  it('never includes a URL (SA carriers flag links as smishing)', async () => {
    const { buildOtpSmsBody } = await load();
    const body = buildOtpSmsBody('482165');
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toMatch(/\.com|\.co\.za|\.io/);
  });
});

describe('SMSPORTAL_FETCH_TIMEOUT_MS', () => {
  it('is the bounded-fetch 8s ceiling (the same discipline as Paystack / Resend)', async () => {
    const { SMSPORTAL_FETCH_TIMEOUT_MS } = await load();
    expect(SMSPORTAL_FETCH_TIMEOUT_MS).toBe(8_000);
  });
});
