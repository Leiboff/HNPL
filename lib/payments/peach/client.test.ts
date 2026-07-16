import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __internals, __resetPeachTokenCache, PeachProvider } from './client';

// ─── Peach Checkout V2 + recurring client unit tests ────────────────
//
// Two credential surfaces on one provider:
//
//   • Checkout V2 — OAuth via /api/oauth/token, POST /v2/checkout,
//     GET /v2/checkout/{id}/status.
//   • Recurring — static Bearer against /v1/registrations/{id}/payments
//     and /v1/payments/{id}. Cannot mix credentials — the tests below
//     pin the invariant.
//
// fetch is mocked. No network required.

const originalFetch = globalThis.fetch;

const CHECKOUT_URL  = 'https://checkout.test';
const RECURRING_URL = 'https://recurring.test';
const AUTH_URL      = 'https://auth.test';

beforeEach(() => {
  __resetPeachTokenCache();

  // Checkout V2 (OAuth) creds.
  process.env.PEACH_AUTH_URL              = AUTH_URL;
  process.env.PEACH_CHECKOUT_URL          = CHECKOUT_URL;
  process.env.PEACH_CHECKOUT_CLIENT_ID    = 'client-id-abc';
  process.env.PEACH_CHECKOUT_CLIENT_SECRET = 'client-secret-xyz';
  process.env.PEACH_CHECKOUT_MERCHANT_ID  = 'merchant-1';
  process.env.PEACH_CHECKOUT_ENTITY_ID    = 'entity-CHECKOUT';

  // Recurring creds — DIFFERENT token and entity than checkout.
  process.env.PEACH_RECURRING_URL         = RECURRING_URL;
  process.env.PEACH_RECURRING_ENTITY_ID   = 'entity-REC';
  process.env.PEACH_RECURRING_ACCESS_TOKEN = 'recurring-bearer';

  process.env.NEXT_PUBLIC_APP_URL         = 'https://app.test';

  // Belt-and-braces: delete the OLD env vars so a regression can't
  // silently re-authenticate through a stale name.
  delete process.env.PEACH_BASE_URL;
  delete process.env.PEACH_ENTITY_ID;
  delete process.env.PEACH_ENTITY_ID_CIT;
  delete process.env.PEACH_ENTITY_ID_RECURRING;
  delete process.env.PEACH_ACCESS_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  __resetPeachTokenCache();
});

// ─── formatAmountCents + toFormBody — unchanged from earlier client ──

describe('formatAmountCents — 2-decimal rands string', () => {
  it('formats a common amount', () => {
    expect(__internals.formatAmountCents(9200)).toBe('92.00');
  });
  it('pads single-digit cents', () => {
    expect(__internals.formatAmountCents(9205)).toBe('92.05');
    expect(__internals.formatAmountCents(1)).toBe('0.01');
  });
  it('rejects fractional cents / negatives', () => {
    expect(() => __internals.formatAmountCents(9200.5)).toThrow(/non-negative integer/);
    expect(() => __internals.formatAmountCents(-1)).toThrow(/non-negative integer/);
  });
});

describe('toFormBody — flattens nested objects with dot-notation', () => {
  it('flattens standingInstruction incl. initialTransactionId', () => {
    const body = __internals.toFormBody({
      standingInstruction: {
        mode: 'REPEATED', source: 'MIT', type: 'INSTALLMENT',
        initialTransactionId: 'txn-init-1',
      },
    });
    expect(body).toContain('standingInstruction.mode=REPEATED');
    expect(body).toContain('standingInstruction.source=MIT');
    expect(body).toContain('standingInstruction.type=INSTALLMENT');
    expect(body).toContain('standingInstruction.initialTransactionId=txn-init-1');
  });
  it('URL-encodes reserved characters', () => {
    const body = __internals.toFormBody({ customer: { email: 'a b+c@x.com' } });
    expect(body).toContain('customer.email=a%20b%2Bc%40x.com');
  });
  it('skips null / undefined values', () => {
    const body = __internals.toFormBody({ a: 'x', b: null, c: undefined, d: 'y' });
    expect(body).toBe('a=x&d=y');
  });
});

// ─── Mock fetch driver ─────────────────────────────────────────────
//
// Sequential responses: the client makes multiple calls in some paths
// (OAuth token fetch + checkout call). scriptedFetch returns responses
// from a queue in FIFO order.

type ScriptedResponse = { url?: RegExp; body: unknown; status?: number };

function scriptedFetch(script: ScriptedResponse[]): ReturnType<typeof vi.fn> {
  const fake = vi.fn(async (url: string) => {
    const next = script.shift();
    if (!next) throw new Error(`Unmocked fetch: ${url}`);
    if (next.url && !next.url.test(url)) throw new Error(`Fetch URL mismatch: got ${url}, expected ${next.url}`);
    return new Response(JSON.stringify(next.body), {
      status:  next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  globalThis.fetch = fake as unknown as typeof fetch;
  return fake;
}

const OAUTH_OK = { url: new RegExp(`${AUTH_URL}/api/oauth/token`), body: { access_token: 'checkout-tok-1', expires_in: 3600 } };

// ─── createCheckout — Checkout V2 OAuth + JSON body ────────────────

describe('PeachProvider.createCheckout — V2 with OAuth + INITIAL/INSTALLMENT/CIT', () => {
  it('fetches an OAuth token, then POSTs /v2/checkout with the correct JSON body', async () => {
    const fake = scriptedFetch([
      OAUTH_OK,
      { url: new RegExp(`${CHECKOUT_URL}/v2/checkout$`), body: { checkoutId: 'chk-1' } },
    ]);
    const p = new PeachProvider();
    const res = await p.createCheckout({
      amountCents: 9200,
      merchantTransactionId: 'hnpl_co_abc',
      currency: 'ZAR',
      paymentType: 'DB',
      createRegistration: true,
      shopperResultUrl: 'https://app.test/checkout/tok/complete',
      origin: 'https://app.test',
      standingInstruction: { mode: 'INITIAL', source: 'CIT', type: 'INSTALLMENT' },
      customer: { email: 'u@x.com' },
    });
    expect(res.checkoutId).toBe('chk-1');
    expect(fake).toHaveBeenCalledTimes(2);

    // 1) OAuth call — JSON body with the credential triple.
    const [oauthUrl, oauthInit] = (fake.mock.calls[0] as unknown) as [string, RequestInit];
    expect(oauthUrl).toBe(`${AUTH_URL}/api/oauth/token`);
    expect(oauthInit.method).toBe('POST');
    const oauthHeaders = oauthInit.headers as Record<string, string>;
    expect(oauthHeaders['Content-Type']).toBe('application/json');
    const oauthBody = JSON.parse(String(oauthInit.body)) as { clientId: string; clientSecret: string; merchantId: string };
    expect(oauthBody.clientId).toBe('client-id-abc');
    expect(oauthBody.clientSecret).toBe('client-secret-xyz');
    expect(oauthBody.merchantId).toBe('merchant-1');

    // 2) Checkout create call — Bearer with the OAuth token, JSON body.
    const [chkUrl, chkInit] = (fake.mock.calls[1] as unknown) as [string, RequestInit];
    expect(chkUrl).toBe(`${CHECKOUT_URL}/v2/checkout`);
    expect(chkInit.method).toBe('POST');
    const chkHeaders = chkInit.headers as Record<string, string>;
    expect(chkHeaders.Authorization).toBe('Bearer checkout-tok-1');
    expect(chkHeaders['Content-Type']).toBe('application/json');
    expect(chkHeaders.Origin).toBe('https://app.test');
    const chkBody = JSON.parse(String(chkInit.body));
    expect(chkBody.authentication).toEqual({ entityId: 'entity-CHECKOUT' });
    expect(chkBody.merchantTransactionId).toBe('hnpl_co_abc');
    expect(chkBody.amount).toBe('92.00');
    expect(chkBody.currency).toBe('ZAR');
    expect(chkBody.paymentType).toBe('DB');
    expect(chkBody.createRegistration).toBe(true);
    expect(chkBody.shopperResultUrl).toBe('https://app.test/checkout/tok/complete');
    expect(chkBody.standingInstruction).toEqual({ mode: 'INITIAL', source: 'CIT', type: 'INSTALLMENT' });
    expect(chkBody.customer).toEqual({ email: 'u@x.com' });
    expect(typeof chkBody.nonce).toBe('string');
    expect(chkBody.nonce.length).toBeGreaterThan(10);
  });

  it('registration-only mode — omits amount + currency + paymentType', async () => {
    const fake = scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout$/, body: { checkoutId: 'chk-reg' } },
    ]);
    const p = new PeachProvider();
    await p.createCheckout({
      amountCents: 0,
      merchantTransactionId: 'hnpl_reg_abc',
      createRegistration: true,
    });
    const chkBody = JSON.parse(String(((fake.mock.calls[1] as unknown) as [string, RequestInit])[1].body));
    expect(chkBody.createRegistration).toBe(true);
    expect(chkBody.amount).toBeUndefined();
    expect(chkBody.currency).toBeUndefined();
    expect(chkBody.paymentType).toBeUndefined();
  });

  it('rejects a fractional / non-integer amount', async () => {
    scriptedFetch([]);
    const p = new PeachProvider();
    await expect(p.createCheckout({
      amountCents: 92.5 as unknown as number,
      merchantTransactionId: 'x',
      standingInstruction: { mode: 'INITIAL', source: 'CIT', type: 'INSTALLMENT' },
    })).rejects.toThrow(/positive integer/);
  });

  it('reuses the cached OAuth token on a second createCheckout call', async () => {
    const fake = scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout$/, body: { checkoutId: 'chk-A' } },
      // NO OAuth call the second time — token is cached.
      { url: /\/v2\/checkout$/, body: { checkoutId: 'chk-B' } },
    ]);
    const p = new PeachProvider();
    await p.createCheckout({ amountCents: 5000, merchantTransactionId: 'x' });
    await p.createCheckout({ amountCents: 6000, merchantTransactionId: 'y' });
    expect(fake).toHaveBeenCalledTimes(3);
    // The three calls were: oauth, checkout-A, checkout-B.
    const [u1] = (fake.mock.calls[0] as unknown) as [string]; expect(u1).toContain('/api/oauth/token');
    const [u2] = (fake.mock.calls[1] as unknown) as [string]; expect(u2).toContain('/v2/checkout');
    const [u3] = (fake.mock.calls[2] as unknown) as [string]; expect(u3).toContain('/v2/checkout');
  });
});

// ─── getCheckoutStatus — V2 GET /v2/checkout/{id}/status ───────────

describe('PeachProvider.getCheckoutStatus — V2 status API', () => {
  it('GETs /v2/checkout/{id}/status with the OAuth Bearer', async () => {
    const fake = scriptedFetch([
      OAUTH_OK,
      {
        url: new RegExp(`${CHECKOUT_URL}/v2/checkout/chk-1/status`),
        body: {
          id: 'pay-1',
          amount: '92.00',
          merchantTransactionId: 'hnpl_co_abc',
          result: { code: '000.100.110' },
          card: { paymentBrand: 'VISA', last4Digits: '4242', expiryMonth: '12', expiryYear: '2030', holder: 'A B' },
          registrationId: 'REG_ABC',
        },
      },
    ]);
    const p = new PeachProvider();
    const st = await p.getCheckoutStatus('chk-1');
    expect(st.status).toBe('success');
    expect(st.amountCents).toBe(9200);
    expect(st.providerPaymentId).toBe('pay-1');
    expect(st.registrationId).toBe('REG_ABC');
    expect(st.card?.brand).toBe('VISA');
    expect(st.card?.last4).toBe('4242');
    const [url, init] = (fake.mock.calls[1] as unknown) as [string, RequestInit];
    expect(url).toBe(`${CHECKOUT_URL}/v2/checkout/chk-1/status`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer checkout-tok-1');
  });
});

// ─── chargeSavedCard — recurring API, DIFFERENT credentials ────────

describe('PeachProvider.chargeSavedCard — recurring endpoint + REPEATED/INSTALLMENT/MIT + initialTransactionId', () => {
  it('POSTs /v1/registrations/{id}/payments with the recurring Bearer + INSTALLMENT + initialTransactionId', async () => {
    const fake = scriptedFetch([
      // No OAuth call — recurring uses a static token.
      {
        url: new RegExp(`${RECURRING_URL}/v1/registrations/REG_ABC/payments`),
        body: {
          id: 'pay-mit-1',
          merchantTransactionId: 'hnpl_abc_a1',
          result: { code: '000.100.110', description: 'Approved' },
        },
      },
    ]);
    const p = new PeachProvider();
    const res = await p.chargeSavedCard({
      registrationId: 'REG_ABC',
      amountCents: 25075,
      merchantTransactionId: 'hnpl_abc_a1',
      standingInstruction: {
        mode: 'REPEATED',
        source: 'MIT',
        type: 'INSTALLMENT',
        initialTransactionId: 'txn-initial-1',
      },
    });
    expect(res.status).toBe('success');
    expect(res.providerPaymentId).toBe('pay-mit-1');
    expect(res.resultCode).toBe('000.100.110');
    expect(fake).toHaveBeenCalledTimes(1);

    const [url, init] = (fake.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe(`${RECURRING_URL}/v1/registrations/REG_ABC/payments`);
    const headers = init.headers as Record<string, string>;
    // The load-bearing credential-separation invariant: the recurring
    // call uses the RECURRING bearer, NOT the OAuth token.
    expect(headers.Authorization).toBe('Bearer recurring-bearer');
    expect(headers.Authorization).not.toBe('Bearer checkout-tok-1');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const body = String(init.body);
    expect(body).toContain('entityId=entity-REC');
    expect(body).not.toContain('entityId=entity-CHECKOUT');
    expect(body).toContain('amount=250.75');
    expect(body).toContain('paymentType=DB');
    expect(body).toContain('standingInstruction.mode=REPEATED');
    expect(body).toContain('standingInstruction.source=MIT');
    expect(body).toContain('standingInstruction.type=INSTALLMENT');
    expect(body).toContain('standingInstruction.initialTransactionId=txn-initial-1');
  });

  it('accepts UNSCHEDULED fallback when there is no initialTransactionId', async () => {
    scriptedFetch([{
      url: /\/v1\/registrations\/REG\/payments/,
      body: { id: 'pay-u-1', result: { code: '000.100.110' } },
    }]);
    const p = new PeachProvider();
    const res = await p.chargeSavedCard({
      registrationId: 'REG',
      amountCents: 5000,
      merchantTransactionId: 'ref',
      standingInstruction: { mode: 'REPEATED', source: 'MIT', type: 'UNSCHEDULED' },
    });
    expect(res.status).toBe('success');
  });

  it('maps a decline result code to status=rejected', async () => {
    scriptedFetch([{
      url: /\/v1\/registrations\/REG\/payments/,
      body: { id: 'pay-2', result: { code: '800.100.152', description: 'Declined' } },
    }]);
    const p = new PeachProvider();
    const res = await p.chargeSavedCard({
      registrationId: 'REG',
      amountCents: 5000,
      merchantTransactionId: 'ref',
      standingInstruction: { mode: 'REPEATED', source: 'MIT', type: 'UNSCHEDULED' },
    });
    expect(res.status).toBe('rejected');
  });

  it('maps a transport error to status=error', async () => {
    globalThis.fetch = (vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    const p = new PeachProvider();
    const res = await p.chargeSavedCard({
      registrationId: 'REG',
      amountCents: 5000,
      merchantTransactionId: 'ref',
      standingInstruction: { mode: 'REPEATED', source: 'MIT', type: 'UNSCHEDULED' },
    });
    expect(res.status).toBe('error');
    expect(res.resultDescription).toMatch(/ECONNREFUSED/);
  });
});

// ─── deleteRegistration — recurring surface ────────────────────────

describe('PeachProvider.deleteRegistration', () => {
  it('DELETEs /v1/registrations/{id} against the recurring entity', async () => {
    const fake = scriptedFetch([{
      url: /\/v1\/registrations\/REG_XYZ/,
      body: { result: { code: '000.100.110' } },
    }]);
    const p = new PeachProvider();
    const res = await p.deleteRegistration('REG_XYZ');
    expect(res.ok).toBe(true);
    const [url, init] = (fake.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe(`${RECURRING_URL}/v1/registrations/REG_XYZ?entityId=entity-REC`);
    expect(init.method).toBe('DELETE');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer recurring-bearer');
  });
});

// ─── refund — RF (default) + RV (reversal) ─────────────────────────

describe('PeachProvider.refund — POST /v1/payments/{id} on the recurring surface', () => {
  it('defaults to paymentType=RF against the recurring entity', async () => {
    const fake = scriptedFetch([{
      url: /\/v1\/payments\/peach-payment-1/,
      body: { id: 'rf-1', result: { code: '000.100.110' } },
    }]);
    const p = new PeachProvider();
    const res = await p.refund('peach-payment-1', 9200, 'hnpl_rf_x');
    expect(res.status).toBe('success');
    expect(res.providerRefundId).toBe('rf-1');
    const [url, init] = (fake.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe(`${RECURRING_URL}/v1/payments/peach-payment-1`);
    expect(init.method).toBe('POST');
    const body = String(init.body);
    expect(body).toContain('paymentType=RF');
    expect(body).toContain('amount=92.00');
    expect(body).toContain('currency=ZAR');
    expect(body).toContain('entityId=entity-REC');
    expect(body).toContain('merchantTransactionId=hnpl_rf_x');
  });

  it('honours { paymentType: "RV" } for preauth reversal', async () => {
    const fake = scriptedFetch([{
      url: /\/v1\/payments\/peach-payment-2/,
      body: { id: 'rv-1', result: { code: '000.100.110' } },
    }]);
    const p = new PeachProvider();
    await p.refund('peach-payment-2', 9200, 'hnpl_rv_x', { paymentType: 'RV' });
    const body = String(((fake.mock.calls[0] as unknown) as [string, RequestInit])[1].body);
    expect(body).toContain('paymentType=RV');
    expect(body).not.toContain('paymentType=RF');
  });
});

// ─── Credential-separation invariant ────────────────────────────────
//
// The load-bearing property of the 0077 split: the recurring surface
// never uses OAuth, and Checkout V2 never uses the recurring bearer.
// A regression here would be a security / correctness failure — a
// single-token client is exactly what 0077 removed.

describe('Credential separation — Checkout vs Recurring never mix', () => {
  it('chargeSavedCard makes NO OAuth call (it uses the static recurring bearer)', async () => {
    const fake = scriptedFetch([{
      url: /\/v1\/registrations\/REG\/payments/,
      body: { id: 'pay-x', result: { code: '000.100.110' } },
    }]);
    const p = new PeachProvider();
    await p.chargeSavedCard({
      registrationId: 'REG',
      amountCents: 5000,
      merchantTransactionId: 'ref',
      standingInstruction: { mode: 'REPEATED', source: 'MIT', type: 'INSTALLMENT', initialTransactionId: 't' },
    });
    // No OAuth token fetch — recurring is authenticated with its own token.
    for (const call of fake.mock.calls) {
      const url = (call as unknown as [string])[0];
      expect(url).not.toContain('/api/oauth/token');
    }
  });

  it('refund makes NO OAuth call — recurring surface', async () => {
    const fake = scriptedFetch([{
      url: /\/v1\/payments\/pay-1/,
      body: { id: 'rf-1', result: { code: '000.100.110' } },
    }]);
    const p = new PeachProvider();
    await p.refund('pay-1', 100, 'hnpl_rf_z');
    for (const call of fake.mock.calls) {
      const url = (call as unknown as [string])[0];
      expect(url).not.toContain('/api/oauth/token');
    }
  });

  it('createCheckout DOES call the OAuth endpoint and NEVER the recurring host', async () => {
    const fake = scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout$/, body: { checkoutId: 'chk-X' } },
    ]);
    const p = new PeachProvider();
    await p.createCheckout({ amountCents: 1000, merchantTransactionId: 'x' });
    for (const call of fake.mock.calls) {
      const url = (call as unknown as [string])[0];
      expect(url).not.toContain(RECURRING_URL);
    }
  });
});
