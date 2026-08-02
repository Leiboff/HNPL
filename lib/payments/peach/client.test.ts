import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __internals, __resetPeachTokenCache, PeachProvider, pickField } from './client';
import { peachRefPurpose } from './refs';

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
      standingInstruction: { mode: 'INITIAL', type: 'INSTALLMENT' },
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
    expect(chkBody.standingInstruction).toEqual({ mode: 'INITIAL', type: 'INSTALLMENT' });
    expect(chkBody.customer).toEqual({ email: 'u@x.com' });
    expect(typeof chkBody.nonce).toBe('string');
    expect(chkBody.nonce.length).toBeGreaterThan(10);
  });

  it('createCheckout REJECTS amountCents=0 UNLESS it is the card-vault recipe (PA + createRegistration)', async () => {
    // Single-door invariant: V2 now serves BOTH purchase (amount > 0)
    // AND the card-vault registration recipe (amount 0 + paymentType
    // 'PA' + createRegistration). A stray amount=0 on a purchase path
    // must still fail loud rather than reaching Peach malformed.
    scriptedFetch([]);
    const p = new PeachProvider();
    // amount=0 with the default DB purchase shape → rejected.
    await expect(p.createCheckout({
      amountCents:           0,
      merchantTransactionId: 'bncABCDEFGHIJKLM',
    })).rejects.toThrow(/positive integer|card-vault recipe/);
    // amount=0 with paymentType 'PA' but WITHOUT createRegistration →
    // still rejected (not the full recipe).
    await expect(p.createCheckout({
      amountCents:           0,
      paymentType:           'PA',
      merchantTransactionId: 'bncABCDEFGHIJKLM',
    })).rejects.toThrow(/positive integer|card-vault recipe/);
  });

  it('createCheckout ACCEPTS amountCents=0 under the full card-vault recipe (PA + createRegistration)', async () => {
    const fake = scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout$/, body: { checkoutId: 'chk-reg-0pa' } },
    ]);
    const p = new PeachProvider();
    const res = await p.createCheckout({
      amountCents:           0,
      paymentType:           'PA',
      createRegistration:    true,
      defaultPaymentMethod:  'CARD',
      forceDefaultMethod:    true,
      merchantTransactionId: 'bnrABCDEFGHIJKLM',
    });
    expect(res.checkoutId).toBe('chk-reg-0pa');
    const chkBody = JSON.parse(String(((fake.mock.calls[1] as unknown) as [string, RequestInit])[1].body));
    expect(chkBody.amount).toBe('0.00');
    expect(chkBody.paymentType).toBe('PA');
    expect(chkBody.createRegistration).toBe(true);
    expect(chkBody.defaultPaymentMethod).toBe('CARD');
    expect(chkBody.forceDefaultMethod).toBe(true);
  });

  it('rejects a fractional / non-integer amount', async () => {
    scriptedFetch([]);
    const p = new PeachProvider();
    await expect(p.createCheckout({
      amountCents: 92.5 as unknown as number,
      merchantTransactionId: 'bnc1234567890abc',
      standingInstruction: { mode: 'INITIAL', type: 'INSTALLMENT' },
    })).rejects.toThrow(/positive integer/);
  });

  it('one-click on a SAVED card — emits cardTokens + allowStoredCards (customer-present CIT)', async () => {
    // The saved-card first instalment (payWithSavedCard) passes the
    // stored token via cardTokens so the widget re-presents the KNOWN
    // card for a mostly-frictionless 3DS one-click. allowStoredCards
    // must accompany it (checkout-tokenisation reference). This is the
    // ONLY way to run a CIT+3DS on a stored token — the recurring API
    // is MIT/S2S.
    const fake = scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout$/, body: { checkoutId: 'chk-oneclick' } },
    ]);
    const p = new PeachProvider();
    await p.createCheckout({
      amountCents:           25000,
      merchantTransactionId: 'bnc1234567890abc',
      currency:              'ZAR',
      paymentType:           'DB',
      createRegistration:    true,
      cardTokens:            ['reg-saved-token-1'],
      allowStoredCards:      true,
      defaultPaymentMethod:  'CARD',
      forceDefaultMethod:    true,
      standingInstruction: {
        mode:                 'INITIAL',
        type:                 'INSTALLMENT',
        expiry:               '2027-01-15',
        frequency:            30,
        numberOfInstallments: 3,
      },
    });
    const chkBody = JSON.parse(String(((fake.mock.calls[1] as unknown) as [string, RequestInit])[1].body));
    expect(chkBody.cardTokens).toEqual(['reg-saved-token-1']);
    expect(chkBody.allowStoredCards).toBe(true);
    expect(chkBody.createRegistration).toBe(true);
    // Still card-only + rooted-INSTALLMENT SI (no OPPWA source).
    expect(chkBody.defaultPaymentMethod).toBe('CARD');
    expect(chkBody.standingInstruction).toEqual({
      mode: 'INITIAL', type: 'INSTALLMENT', expiry: '2027-01-15', frequency: 30, numberOfInstallments: 3,
    });
    expect(chkBody.standingInstruction.source).toBeUndefined();
  });

  it('omits cardTokens / allowStoredCards on a normal new-card checkout', async () => {
    const fake = scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout$/, body: { checkoutId: 'chk-newcard' } },
    ]);
    const p = new PeachProvider();
    await p.createCheckout({
      amountCents: 9200,
      merchantTransactionId: 'bnc1234567890abc',
      standingInstruction: { mode: 'INITIAL', type: 'INSTALLMENT' },
    });
    const chkBody = JSON.parse(String(((fake.mock.calls[1] as unknown) as [string, RequestInit])[1].body));
    expect(chkBody.cardTokens).toBeUndefined();
    expect(chkBody.allowStoredCards).toBeUndefined();
  });

  it('rejects a merchantTransactionId longer than 16 characters', async () => {
    scriptedFetch([]);
    const p = new PeachProvider();
    await expect(p.createCheckout({
      amountCents: 1000,
      merchantTransactionId: 'this-ref-is-way-too-long-for-peach-v2',
      standingInstruction: { mode: 'INITIAL', type: 'INSTALLMENT' },
    })).rejects.toThrow(/1-16 chars/);
  });

  it('Flow A — V2 SI: mode + type + expiry + frequency INT + numberOfInstallments (NO source, NO initialTransactionId)', async () => {
    // Load-bearing pin per the Peach V2 /v2/checkout schema
    // (developer.peachpayments.com/reference/post_v2-checkout):
    //
    //   V2 accepts: mode, type, expiry, frequency, numberOfInstallments,
    //               recurringType, industryPractice.
    //   V2 REJECTS: `source` (CIT/MIT) and `initialTransactionId` —
    //               those are OPPWA/recurring vocabulary that would
    //               come back as {"standingInstruction.source":
    //               "unknown field"} on 2026-07-30.
    //
    // Do NOT send recurringType for type=INSTALLMENT (only RECURRING).
    const fake = scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout$/, body: { checkoutId: 'chk-A-full' } },
    ]);
    const p = new PeachProvider();
    await p.createCheckout({
      amountCents:           30000,
      merchantTransactionId: 'bnc1234567890abc',
      currency:              'ZAR',
      paymentType:           'DB',
      createRegistration:    true,
      standingInstruction: {
        mode:                 'INITIAL',
        type:                 'INSTALLMENT',
        expiry:               '2027-01-15',
        frequency:            30,
        numberOfInstallments: 3,
      },
    });
    const chkBody = JSON.parse(String(((fake.mock.calls[1] as unknown) as [string, RequestInit])[1].body));
    expect(chkBody.standingInstruction).toEqual({
      mode:                 'INITIAL',
      type:                 'INSTALLMENT',
      expiry:               '2027-01-15',
      frequency:            30,
      numberOfInstallments: 3,
    });
    // V2 REJECTIONS — must be absent from the wire body:
    expect(chkBody.standingInstruction.source).toBeUndefined();
    expect(chkBody.standingInstruction.initialTransactionId).toBeUndefined();
    // recurringType MUST NOT appear on an INSTALLMENT initiate.
    expect(chkBody.standingInstruction.recurringType).toBeUndefined();
  });

  it('Flow A — planType=2 sends numberOfInstallments=2 (was the "Invalid request body" case)', async () => {
    const fake = scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout$/, body: { checkoutId: 'chk-A-n2' } },
    ]);
    const p = new PeachProvider();
    await p.createCheckout({
      amountCents:           25000,
      merchantTransactionId: 'bncABCDEFGHIJKLM',
      currency:              'ZAR',
      paymentType:           'DB',
      createRegistration:    true,
      standingInstruction: {
        mode:                 'INITIAL',
        type:                 'INSTALLMENT',
        expiry:               '2027-01-15',
        frequency:            30,
        numberOfInstallments: 2,
      },
    });
    const chkBody = JSON.parse(String(((fake.mock.calls[1] as unknown) as [string, RequestInit])[1].body));
    expect(chkBody.standingInstruction.numberOfInstallments).toBe(2);
    expect(chkBody.standingInstruction.frequency).toBe(30);
    expect(chkBody.standingInstruction.expiry).toBe('2027-01-15');
    // Regression against the 2026-07-30 "unknown field" rejection:
    expect(chkBody.standingInstruction.source).toBeUndefined();
    expect(chkBody.standingInstruction.initialTransactionId).toBeUndefined();
  });

  it('Flow A — client BOUNDARY strips source/initialTransactionId if a caller regresses and passes them', async () => {
    // Defense-in-depth: even if a caller is refactored back to pass
    // OPPWA-shape SI (source/initialTransactionId), the V2 client
    // MUST strip them at the boundary so Peach V2 accepts the body.
    // The type is narrower than what we filter — TS blocks compile-
    // time, this pin blocks runtime.
    const fake = scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout$/, body: { checkoutId: 'chk-A-scrub' } },
    ]);
    const p = new PeachProvider();
    await p.createCheckout({
      amountCents:           1000,
      merchantTransactionId: 'bncXYZXYZXYZXYZ',
      createRegistration:    true,
      // Cast — the type intentionally omits these, but the RUNTIME
      // filter must strip them if a JS-only caller somehow includes
      // them (or the type is loosened in a future edit).
      standingInstruction: {
        mode:                 'INITIAL',
        type:                 'INSTALLMENT',
        expiry:               '2027-01-15',
        frequency:            30,
        numberOfInstallments: 2,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        source:               'CIT',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        initialTransactionId: 'should-not-be-sent',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    const chkBody = JSON.parse(String(((fake.mock.calls[1] as unknown) as [string, RequestInit])[1].body));
    expect(chkBody.standingInstruction.source).toBeUndefined();
    expect(chkBody.standingInstruction.initialTransactionId).toBeUndefined();
  });

  it('logs "PEACH CHECKOUT INITIATE ERROR:" with raw body on a 400 from /v2/checkout', async () => {
    // Otherwise Peach's "Invalid request body" lands as a generic
    // Error message with no context on which field they rejected.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    scriptedFetch([
      OAUTH_OK,
      {
        url:    /\/v2\/checkout$/,
        status: 400,
        body:   { errorCode: 'InvalidRequestBody', errorMessage: 'authentication.entityId is required' },
      },
    ]);
    const p = new PeachProvider();
    await expect(p.createCheckout({
      amountCents:           1000,
      merchantTransactionId: 'bnc1234567890abc',
    })).rejects.toThrow();
    const emitted = errSpy.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(emitted).toContain('PEACH CHECKOUT INITIATE ERROR');
    expect(emitted).toContain('InvalidRequestBody');
    expect(emitted).toContain('authentication.entityId is required');
    errSpy.mockRestore();
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

// ─── createCardRegistration — Flow B card-vault on the V2 door ──────
//
// Card-add now runs on the SAME Checkout V2 surface via the
// zero-amount PA registration recipe. These pins lock the exact
// wire body: amount 0, paymentType 'PA', createRegistration, card-only
// (defaultPaymentMethod 'CARD' + forceDefaultMethod), and — critically
// — NO standingInstruction (a pure vault has no scheme SI until an
// INITIAL CIT/MIT actually charges).

describe('PeachProvider.createCardRegistration — zero-amount PA registration recipe (V2)', () => {
  it('POSTs /v2/checkout with amount 0 + PA + createRegistration + card-only, and NO standingInstruction', async () => {
    const fake = scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout$/, body: { checkoutId: 'chk-reg-1' } },
    ]);
    const p = new PeachProvider();
    const res = await p.createCardRegistration({
      merchantTransactionId: 'bnrABCDEFGHIJKLM',
      shopperResultUrl:      'https://app.test/patient/payment-methods/complete',
      origin:                'https://app.test',
      customer:              { email: 'p@x.com', givenName: 'Alice', surname: 'Test' },
      customParameters:      { SHOPPER_purpose: 'card_registration', SHOPPER_patientId: 'user-1' },
    });
    expect(res.checkoutId).toBe('chk-reg-1');
    expect(fake).toHaveBeenCalledTimes(2);

    // The checkout create call — OAuth Bearer, JSON, Origin header.
    const [chkUrl, chkInit] = (fake.mock.calls[1] as unknown) as [string, RequestInit];
    expect(chkUrl).toBe(`${CHECKOUT_URL}/v2/checkout`);
    const chkHeaders = chkInit.headers as Record<string, string>;
    expect(chkHeaders.Authorization).toBe('Bearer checkout-tok-1');
    expect(chkHeaders.Origin).toBe('https://app.test');

    const chkBody = JSON.parse(String(chkInit.body));
    // The registration recipe — every field pinned.
    expect(chkBody.amount).toBe('0.00');
    expect(chkBody.paymentType).toBe('PA');
    expect(chkBody.createRegistration).toBe(true);
    expect(chkBody.defaultPaymentMethod).toBe('CARD');
    expect(chkBody.forceDefaultMethod).toBe(true);
    expect(chkBody.merchantTransactionId).toBe('bnrABCDEFGHIJKLM');
    expect(chkBody.shopperResultUrl).toBe('https://app.test/patient/payment-methods/complete');
    expect(chkBody.customer).toEqual({ email: 'p@x.com', givenName: 'Alice', surname: 'Test' });
    expect(chkBody.customParameters).toEqual({ SHOPPER_purpose: 'card_registration', SHOPPER_patientId: 'user-1' });
    // A pure vault carries NO standing instruction.
    expect(chkBody.standingInstruction).toBeUndefined();
    // Registration refs are purpose 'r' and ≤ 16 chars.
    expect(peachRefPurpose(chkBody.merchantTransactionId)).toBe('r');
    expect(chkBody.merchantTransactionId.length).toBeLessThanOrEqual(16);
  });

  it('uses the Checkout OAuth surface (never the recurring host)', async () => {
    const fake = scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout$/, body: { checkoutId: 'chk-reg-2' } },
    ]);
    const p = new PeachProvider();
    await p.createCardRegistration({
      merchantTransactionId: 'bnrABCDEFGHIJKLM',
      shopperResultUrl:      'https://app.test/patient/payment-methods/complete',
    });
    // Exactly the OAuth call + the /v2/checkout call; never a recurring
    // /v1 host and never /v1/checkouts (the old COPYandPAY door).
    const urls = fake.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls[0]).toContain('/api/oauth/token');
    expect(urls[1]).toBe(`${CHECKOUT_URL}/v2/checkout`);
    for (const u of urls) {
      expect(u).not.toContain(RECURRING_URL);
      expect(u).not.toContain('/v1/checkouts');
    }
  });
});

// ─── Registration status — a 0-PA vault reads registrationId + card ─
//
// The completion route reads a card-vault result via getCheckoutStatus
// (NOT a separate registration-status call). The flat V2 status body
// carries result.code + registrationId + card.* with amount 0 — a
// stored token and NO charge.

describe('PeachProvider.getCheckoutStatus — 0-PA registration status (flat body)', () => {
  it('returns registrationId + card and a zero amount for a successful vault', async () => {
    scriptedFetch([
      OAUTH_OK,
      {
        url:  /\/v2\/checkout\/.+\/status$/,
        body: {
          id:                          'pa-0-txn-1',
          'result.code':               '000.100.110',
          'result.description':        'Request successfully processed',
          merchantTransactionId:       'bnrABCDEFGHIJKLM',
          amount:                      '0.00',
          paymentType:                 'PA',
          registrationId:              'reg-vault-abc',
          'card.paymentBrand':         'VISA',
          'card.last4Digits':          '4242',
          'card.expiryMonth':          '12',
          'card.expiryYear':           '2030',
          'card.holder':               'Alice Test',
        },
      },
    ]);
    const p = new PeachProvider();
    const st = await p.getCheckoutStatus('chk-reg-1');
    expect(st.status).toBe('success');
    expect(st.registrationId).toBe('reg-vault-abc');
    expect(st.merchantTransactionId).toBe('bnrABCDEFGHIJKLM');
    expect(peachRefPurpose(st.merchantTransactionId)).toBe('r');
    expect(st.amountCents).toBe(0);
    expect(st.card?.brand).toBe('VISA');
    expect(st.card?.last4).toBe('4242');
    expect(st.card?.expiryMonth).toBe(12);
    expect(st.card?.expiryYear).toBe(2030);
  });
});

// ─── paymentBrand lives at the TOP LEVEL, not under card ───────────
//
// Peach returns paymentBrand as a SIBLING of the `card` object (proven
// against the docs), NOT card.paymentBrand. Reading card.paymentBrand
// returned undefined → every saved card got brand "Card" + a NULL
// fingerprint → dedup was globally broken. toPaymentStatus must read
// top-level paymentBrand first, tolerating a nested card.paymentBrand
// as a fallback. last4/expiry genuinely live under card and are
// unchanged.

describe('PeachProvider.getCheckoutStatus — paymentBrand is top-level', () => {
  const CARD_FIELDS = {
    'card.last4Digits': '0042',
    'card.expiryMonth': '02',
    'card.expiryYear':  '2031',
    'card.holder':      'Jane Doe',
  };

  it('reads the REAL shape: top-level paymentBrand, card.* for the rest', async () => {
    scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout\/.+\/status$/, body: {
        id: 'p-top', 'result.code': '000.100.110',
        merchantTransactionId: 'bncTOPLEVELBRAND', amount: '92.00',
        registrationId: 'reg-top',
        paymentBrand: 'VISA',            // ← top-level, sibling of card
        ...CARD_FIELDS,                  // ← NO card.paymentBrand at all
      } },
    ]);
    const st = await new PeachProvider().getCheckoutStatus('chk-top');
    expect(st.card?.brand).toBe('VISA');
    // last4 + expiry still read correctly from card.*
    expect(st.card?.last4).toBe('0042');
    expect(st.card?.expiryMonth).toBe(2);
    expect(st.card?.expiryYear).toBe(2031);
  });

  it('falls back to nested card.paymentBrand when no top-level paymentBrand', async () => {
    scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout\/.+\/status$/, body: {
        id: 'p-fb', 'result.code': '000.100.110',
        merchantTransactionId: 'bncFALLBACKBRD', amount: '92.00',
        registrationId: 'reg-fb',
        'card.paymentBrand': 'MASTERCARD',   // only the nested one present
        ...CARD_FIELDS,
      } },
    ]);
    const st = await new PeachProvider().getCheckoutStatus('chk-fb');
    expect(st.card?.brand).toBe('MASTERCARD');
  });

  it('top-level paymentBrand WINS when both are present', async () => {
    scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout\/.+\/status$/, body: {
        id: 'p-both', 'result.code': '000.100.110',
        merchantTransactionId: 'bncBOTHBRANDS', amount: '92.00',
        registrationId: 'reg-both',
        paymentBrand: 'VISA',
        'card.paymentBrand': 'MASTERCARD',
        ...CARD_FIELDS,
      } },
    ]);
    const st = await new PeachProvider().getCheckoutStatus('chk-both');
    expect(st.card?.brand).toBe('VISA');
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

  // ── FLAT dot-notation body (prod false-decline regression) ──────────
  //
  // The GET /v2/checkout/{id}/status body is FLAT — keys are literal
  // "result.code", "card.last4Digits" etc, NOT nested objects. Reading
  // body.result?.code returned undefined → a SUCCESSFUL charge classified
  // 'rejected'. Real prod fixture: checkout 0ea34011d7924ed9aa4ede361c758e5e,
  // result.code 000.100.110, registrationId 8ac7a49f…, card.last4Digits
  // 0042, ref bnc2b23vwkixm97y. toPaymentStatus must tolerate flat AND
  // nested via pickField.

  // The exact flat shape from the production log.
  const FLAT_SUCCESS_BODY: Record<string, unknown> = {
    'result.code':        '000.100.110',
    'result.description': "Request successfully processed in 'Merchant in Integrator Test Mode'",
    id:                    'pay-flat-0ea3',
    merchantTransactionId: 'bnc2b23vwkixm97y',
    amount:                '92.00',
    currency:              'ZAR',
    'card.bin':            '400000',
    'card.last4Digits':    '0042',
    'card.holder':         'Jane Doe',
    'card.expiryMonth':    '12',
    'card.expiryYear':     '2030',
    'card.paymentBrand':   'VISA',
    registrationId:        '8ac7a49f9fb7fec7019fbf26b73e7852',
  };

  it('parses the REAL flat prod body → success + registrationId + code + card', async () => {
    scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout\/chk-flat\/status/, body: FLAT_SUCCESS_BODY },
    ]);
    const p = new PeachProvider();
    const st = await p.getCheckoutStatus('chk-flat');
    expect(st.status).toBe('success');                 // was 'rejected' — the bug
    expect(st.resultCode).toBe('000.100.110');
    expect(st.registrationId).toBe('8ac7a49f9fb7fec7019fbf26b73e7852');
    expect(st.providerPaymentId).toBe('pay-flat-0ea3');
    expect(st.merchantTransactionId).toBe('bnc2b23vwkixm97y');
    expect(st.amountCents).toBe(9200);
    expect(st.card?.last4).toBe('0042');
    expect(st.card?.brand).toBe('VISA');
    expect(st.card?.expiryMonth).toBe(12);
    expect(st.resultDescription).toMatch(/Integrator Test Mode/);
  });

  it('parses the equivalent NESTED body → identical result (both shapes tolerated)', async () => {
    const NESTED_SUCCESS_BODY = {
      result: {
        code:        '000.100.110',
        description: "Request successfully processed in 'Merchant in Integrator Test Mode'",
      },
      id:                    'pay-flat-0ea3',
      merchantTransactionId: 'bnc2b23vwkixm97y',
      amount:                '92.00',
      currency:              'ZAR',
      card: {
        bin: '400000', last4Digits: '0042', holder: 'Jane Doe',
        expiryMonth: '12', expiryYear: '2030', paymentBrand: 'VISA',
      },
      registrationId: '8ac7a49f9fb7fec7019fbf26b73e7852',
    };
    scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout\/chk-nested\/status/, body: NESTED_SUCCESS_BODY },
    ]);
    const p = new PeachProvider();
    const st = await p.getCheckoutStatus('chk-nested');
    expect(st.status).toBe('success');
    expect(st.resultCode).toBe('000.100.110');
    expect(st.registrationId).toBe('8ac7a49f9fb7fec7019fbf26b73e7852');
    expect(st.card?.last4).toBe('0042');
    expect(st.card?.brand).toBe('VISA');
  });

  it('a FLAT body with a decline code → rejected (parse fix does not over-accept)', async () => {
    scriptedFetch([
      OAUTH_OK,
      {
        url: /\/v2\/checkout\/chk-flat-decline\/status/,
        body: {
          'result.code':        '800.100.152',
          'result.description': 'Transaction declined by authorization system',
          id:                    'pay-flat-decl',
          merchantTransactionId: 'bncdeclinexxxxx',
        },
      },
    ]);
    const p = new PeachProvider();
    const st = await p.getCheckoutStatus('chk-flat-decline');
    expect(st.status).toBe('rejected');
    expect(st.resultCode).toBe('800.100.152');
  });

  // ── Completion purpose guard — real prod fixture 03e9c095… ──────────
  //
  // The V2 status body returns customParameters as BRACKETED FLAT keys
  // ('customParameters[SHOPPER_purpose]'). The completion page does NOT
  // read them — it derives the reference from merchantTransactionId and
  // gates on peachRefPurpose(ref) === 'c'. This fixture proves the full
  // flat body (bracketed customParameters included) parses to the compact
  // checkout ref, and that ref classifies as a checkout ('c') so the
  // completion path reaches activation instead of the "isn't from a
  // checkout flow" rejection.
  it('parses the full prod flat body (bracketed customParameters) → checkout-purpose ref', async () => {
    const PROD_FLAT_BODY: Record<string, unknown> = {
      'result.code':        '000.100.110',
      'result.description': "Request successfully processed in 'Merchant in Integrator Test Mode'",
      id:                    'pay-03e9c095',
      merchantTransactionId: 'bnc26xa9mdv8z0yi',
      amount:                '92.00',
      currency:              'ZAR',
      'card.bin':            '400000',
      'card.last4Digits':    '0042',
      'card.paymentBrand':   'VISA',
      registrationId:        '8ac7a49f9fb7fec7019fbf26b73e7852',
      // customParameters echoed back as bracketed flat keys — present in
      // the body but NOT read by the completion path.
      'customParameters[SHOPPER_purpose]':   'checkout_first_payment',
      'customParameters[SHOPPER_planId]':    '43dd8174-0000-0000-0000-000000000000',
      'customParameters[SHOPPER_paymentId]': 'pmt-1',
      'customParameters[SHOPPER_patientId]': 'usr-1',
      'customParameters[SHOPPER_token]':     'tok-1',
    };
    scriptedFetch([
      OAUTH_OK,
      { url: /\/v2\/checkout\/chk-03e9\/status/, body: PROD_FLAT_BODY },
    ]);
    const p = new PeachProvider();
    const st = await p.getCheckoutStatus('chk-03e9');

    expect(st.status).toBe('success');
    expect(st.merchantTransactionId).toBe('bnc26xa9mdv8z0yi');
    expect(st.registrationId).toBe('8ac7a49f9fb7fec7019fbf26b73e7852');
    // The completion guard input: this compact ref is a checkout CIT ('c'),
    // so the page passes the purpose gate and reaches activation.
    expect(peachRefPurpose(st.merchantTransactionId)).toBe('c');
    // The legacy prefix check would have FALSELY rejected it — the bug.
    expect(st.merchantTransactionId?.startsWith('hnpl_co_')).toBe(false);
  });
});

describe('pickField — flat-or-nested reader (V2 status only)', () => {
  it('reads a flat literal dotted key', () => {
    expect(pickField({ 'result.code': '000.100.110' }, 'result.code')).toBe('000.100.110');
    expect(pickField({ 'card.last4Digits': '0042' }, 'card.last4Digits')).toBe('0042');
  });
  it('falls back to a nested walk', () => {
    expect(pickField({ result: { code: '000.100.110' } }, 'result.code')).toBe('000.100.110');
    expect(pickField({ card: { last4Digits: '0042' } }, 'card.last4Digits')).toBe('0042');
  });
  it('prefers the flat key when BOTH are present', () => {
    expect(pickField({ 'result.code': 'FLAT', result: { code: 'NESTED' } }, 'result.code')).toBe('FLAT');
  });
  it('returns undefined for a missing path (no throw on non-objects)', () => {
    expect(pickField({ result: 'not-an-object' }, 'result.code')).toBeUndefined();
    expect(pickField({}, 'result.code')).toBeUndefined();
    expect(pickField(null, 'result.code')).toBeUndefined();
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

  // ── Echoed initialTransactionId (chain root) ──────────────────────
  //
  // Peach echoes standingInstruction.initialTransactionId on REPEATED
  // responses to point at the CIT root of the credential chain. The
  // client must surface it as a DISTINCT field from providerPaymentId
  // (which is this response's OWN id — an MIT id, wrong to thread as
  // a later charge's initialTransactionId).

  it('surfaces echoed standingInstruction.initialTransactionId as a distinct result field', async () => {
    scriptedFetch([{
      url: /\/v1\/registrations\/REG\/payments/,
      body: {
        id: 'pay-mit-id',
        result: { code: '000.100.110' },
        standingInstruction: { initialTransactionId: 'CIT-ROOT-1' },
      },
    }]);
    const p = new PeachProvider();
    const res = await p.chargeSavedCard({
      registrationId: 'REG',
      amountCents: 5000,
      merchantTransactionId: 'ref',
      standingInstruction: { mode: 'REPEATED', source: 'MIT', type: 'UNSCHEDULED' },
    });
    expect(res.providerPaymentId).toBe('pay-mit-id');    // this MIT's own id
    expect(res.initialTransactionId).toBe('CIT-ROOT-1'); // echoed chain root
    // Load-bearing separation: chain root MUST NOT be the MIT's own id.
    expect(res.initialTransactionId).not.toBe(res.providerPaymentId);
  });

  it('leaves initialTransactionId undefined when Peach does not echo it', async () => {
    scriptedFetch([{
      url: /\/v1\/registrations\/REG\/payments/,
      body: {
        id: 'pay-mit-solo',
        result: { code: '000.100.110' },
        // No standingInstruction object at all.
      },
    }]);
    const p = new PeachProvider();
    const res = await p.chargeSavedCard({
      registrationId: 'REG',
      amountCents: 5000,
      merchantTransactionId: 'ref',
      standingInstruction: { mode: 'REPEATED', source: 'MIT', type: 'UNSCHEDULED' },
    });
    expect(res.status).toBe('success');
    expect(res.providerPaymentId).toBe('pay-mit-solo');
    // Absence is a distinct state — the caller uses this to decide
    // NOT to stamp plans.peach_initial_transaction_id.
    expect(res.initialTransactionId).toBeUndefined();
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
