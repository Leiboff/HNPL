import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __internals, PeachProvider } from './client';

// ─── Peach client unit tests ────────────────────────────────────────
//
// Amount formatting, form-body flattening, and the four provider
// methods (createCheckout, getCheckoutStatus, chargeSavedCard,
// deleteRegistration). fetch is mocked; no network required.

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.PEACH_BASE_URL   = 'https://sandbox-card.peachpayments.com';
  process.env.PEACH_ENTITY_ID  = 'ent-123';
  process.env.PEACH_ACCESS_TOKEN = 'tok-xyz';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

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
  it('flattens standingInstruction', () => {
    const body = __internals.toFormBody({
      standingInstruction: { mode: 'INITIAL', source: 'CIT', type: 'UNSCHEDULED' },
    });
    expect(body).toContain('standingInstruction.mode=INITIAL');
    expect(body).toContain('standingInstruction.source=CIT');
    expect(body).toContain('standingInstruction.type=UNSCHEDULED');
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

// ─── Provider methods ──────────────────────────────────────────────

function mockFetch(response: unknown, status = 200) {
  const fake = vi.fn(async () => new Response(JSON.stringify(response), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
  globalThis.fetch = fake as unknown as typeof fetch;
  return fake;
}

describe('PeachProvider.createCheckout — CIT / INITIAL / UNSCHEDULED with amount', () => {
  it('POSTs /v1/checkouts with server-computed amount + standingInstruction trio + Bearer auth', async () => {
    const fake = mockFetch({ id: 'chk-1' });
    const p = new PeachProvider();
    const res = await p.createCheckout({
      amountCents: 9200,
      merchantTransactionId: 'hnpl_co_abc',
      currency: 'ZAR',
      paymentType: 'DB',
      createRegistration: true,
      standingInstruction: { mode: 'INITIAL', source: 'CIT', type: 'UNSCHEDULED' },
      customer: { email: 'u@x.com' },
    });
    expect(res.checkoutId).toBe('chk-1');
    expect(fake).toHaveBeenCalledTimes(1);
    const call = fake.mock.calls[0]! as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://sandbox-card.peachpayments.com/v1/checkouts');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-xyz');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = String(init.body);
    expect(body).toContain('entityId=ent-123');
    expect(body).toContain('amount=92.00');
    expect(body).toContain('currency=ZAR');
    expect(body).toContain('paymentType=DB');
    expect(body).toContain('createRegistration=true');
    expect(body).toContain('standingInstruction.mode=INITIAL');
    expect(body).toContain('standingInstruction.source=CIT');
    expect(body).toContain('standingInstruction.type=UNSCHEDULED');
    expect(body).toContain('merchantTransactionId=hnpl_co_abc');
  });

  it('rejects a client-supplied fractional / non-integer amount', async () => {
    mockFetch({ id: 'chk-2' });
    const p = new PeachProvider();
    await expect(p.createCheckout({
      amountCents: 92.5 as unknown as number,
      merchantTransactionId: 'x',
      standingInstruction: { mode: 'INITIAL', source: 'CIT', type: 'UNSCHEDULED' },
    })).rejects.toThrow(/positive integer/);
  });

  it('registration-only mode — omits amount + currency + paymentType', async () => {
    const fake = mockFetch({ id: 'chk-reg' });
    const p = new PeachProvider();
    await p.createCheckout({
      amountCents: 0,
      merchantTransactionId: 'hnpl_reg_abc',
      createRegistration: true,
    });
    const body = String(((fake.mock.calls[0] as unknown) as [string, RequestInit])[1].body);
    expect(body).toContain('createRegistration=true');
    expect(body).not.toContain('amount=');
    expect(body).not.toContain('currency=');
    expect(body).not.toContain('paymentType=');
  });

  it('encodes customParameters with the customParameters[NAME]=value shape', async () => {
    const fake = mockFetch({ id: 'chk-cp' });
    const p = new PeachProvider();
    await p.createCheckout({
      amountCents: 5000,
      merchantTransactionId: 'x',
      standingInstruction: { mode: 'INITIAL', source: 'CIT', type: 'UNSCHEDULED' },
      customParameters: { SHOPPER_planId: 'plan-1' },
    });
    const body = String(((fake.mock.calls[0] as unknown) as [string, RequestInit])[1].body);
    expect(decodeURIComponent(body)).toContain('customParameters[SHOPPER_planId]=plan-1');
  });
});

describe('PeachProvider.chargeSavedCard — MIT / REPEATED / UNSCHEDULED', () => {
  it('POSTs /v1/registrations/{id}/payments with the MIT triple', async () => {
    const fake = mockFetch({
      id: 'pay-1',
      merchantTransactionId: 'hnpl_abc_a1',
      result: { code: '000.100.110', description: 'Approved' },
    });
    const p = new PeachProvider();
    const res = await p.chargeSavedCard({
      registrationId: 'REG_ABC',
      amountCents: 25075,
      merchantTransactionId: 'hnpl_abc_a1',
      standingInstruction: { mode: 'REPEATED', source: 'MIT', type: 'UNSCHEDULED' },
    });
    expect(res.status).toBe('success');
    expect(res.providerPaymentId).toBe('pay-1');
    expect(res.resultCode).toBe('000.100.110');
    const [url, init] = (fake.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe('https://sandbox-card.peachpayments.com/v1/registrations/REG_ABC/payments');
    const body = String(init.body);
    expect(body).toContain('amount=250.75');
    expect(body).toContain('paymentType=DB');
    expect(body).toContain('standingInstruction.mode=REPEATED');
    expect(body).toContain('standingInstruction.source=MIT');
    expect(body).toContain('standingInstruction.type=UNSCHEDULED');
  });

  it('maps a decline result code to status=rejected', async () => {
    mockFetch({ id: 'pay-2', result: { code: '800.100.152', description: 'Declined' } });
    const p = new PeachProvider();
    const res = await p.chargeSavedCard({
      registrationId: 'REG',
      amountCents: 5000,
      merchantTransactionId: 'ref',
      standingInstruction: { mode: 'REPEATED', source: 'MIT', type: 'UNSCHEDULED' },
    });
    expect(res.status).toBe('rejected');
  });

  it('maps a transport error to status=error (leaves caller to handle)', async () => {
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

describe('PeachProvider.getCheckoutStatus — GET resourcePath with entityId', () => {
  it('appends entityId query param + Bearer auth', async () => {
    const fake = mockFetch({
      id: 'pay-1',
      amount: '92.00',
      merchantTransactionId: 'hnpl_co_abc',
      result: { code: '000.100.110' },
      card: { paymentBrand: 'VISA', last4Digits: '4242', expiryMonth: '12', expiryYear: '2030', holder: 'A B' },
      registrationId: 'REG_ABC',
    });
    const p = new PeachProvider();
    const st = await p.getCheckoutStatus('/v1/checkouts/chk-1/payment');
    expect(st.status).toBe('success');
    expect(st.amountCents).toBe(9200);
    expect(st.registrationId).toBe('REG_ABC');
    expect(st.card?.brand).toBe('VISA');
    expect(st.card?.last4).toBe('4242');
    const [url] = (fake.mock.calls[0] as unknown) as [string];
    expect(url).toBe('https://sandbox-card.peachpayments.com/v1/checkouts/chk-1/payment?entityId=ent-123');
  });
});

describe('PeachProvider.deleteRegistration', () => {
  it('DELETEs /v1/registrations/{id}', async () => {
    const fake = mockFetch({ result: { code: '000.100.110' } });
    const p = new PeachProvider();
    const res = await p.deleteRegistration('REG_XYZ');
    expect(res.ok).toBe(true);
    const [url, init] = (fake.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe('https://sandbox-card.peachpayments.com/v1/registrations/REG_XYZ?entityId=ent-123');
    expect(init.method).toBe('DELETE');
  });
});
