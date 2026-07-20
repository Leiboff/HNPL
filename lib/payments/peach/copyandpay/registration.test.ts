import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createCardRegistration,
  getCardRegistrationStatus,
  __internals,
} from './registration';

// ─── COPYandPAY registration-only vault — request/response tests ────
//
// The critical pins:
//   • Registration POST body carries the RIGHT fields:
//       entityId (recurring family), merchantTransactionId (compact),
//       createRegistration='true', customer.*, customParameters[…].
//   • Registration POST body carries NONE of the paying-flow fields:
//       amount, currency, paymentType, standingInstruction.
//     These are the exact fields whose ABSENCE distinguishes a vault
//     from a debit — sending any of them is a schema mismatch.
//   • Bearer header uses PEACH_RECURRING_ACCESS_TOKEN (never Checkout
//     OAuth) — dual-door credential separation invariant.
//   • Status GET appends `?entityId=<recurring>` to the resourcePath.

const originalFetch = globalThis.fetch;

const RECURRING_URL = 'https://recurring.test';

beforeEach(() => {
  process.env.PEACH_RECURRING_URL          = RECURRING_URL;
  process.env.PEACH_RECURRING_ENTITY_ID    = 'entity-REC';
  process.env.PEACH_RECURRING_ACCESS_TOKEN = 'recurring-bearer';
  // Belt-and-braces: any Checkout V2 env should NOT be needed by this
  // module. Deleting them proves the door doesn't leak into V2.
  delete process.env.PEACH_CHECKOUT_URL;
  delete process.env.PEACH_CHECKOUT_ENTITY_ID;
  delete process.env.PEACH_CHECKOUT_CLIENT_ID;
  delete process.env.PEACH_CHECKOUT_CLIENT_SECRET;
  delete process.env.PEACH_CHECKOUT_MERCHANT_ID;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function scriptedFetch(response: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fake = vi.fn(async () => new Response(JSON.stringify(response), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
  globalThis.fetch = fake as unknown as typeof fetch;
  return fake;
}

// ─── createCardRegistration ─────────────────────────────────────────

describe('createCardRegistration — request body shape', () => {
  it('POSTs /v1/checkouts with the exact registration-only field set', async () => {
    const fake = scriptedFetch({ id: 'chk-reg-1' });
    const res = await createCardRegistration({
      merchantTransactionId: 'bnrABCDEFGHIJKLM',
      customer: { email: 'p@x.com', givenName: 'Alice', surname: 'Test' },
      customParameters: {
        SHOPPER_purpose:   'card_registration',
        SHOPPER_patientId: 'user-1',
      },
    });
    expect(res.checkoutId).toBe('chk-reg-1');

    const [url, init] = (fake.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe(`${RECURRING_URL}/v1/checkouts`);
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer recurring-bearer');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    // Body is form-urlencoded. Decode for assertions.
    const body = decodeURIComponent(String(init.body));

    // PRESENT — the registration-only recipe.
    expect(body).toContain('entityId=entity-REC');
    expect(body).toContain('merchantTransactionId=bnrABCDEFGHIJKLM');
    expect(body).toContain('createRegistration=true');
    expect(body).toContain('customer.email=p@x.com');
    expect(body).toContain('customer.givenName=Alice');
    expect(body).toContain('customer.surname=Test');
    expect(body).toContain('customParameters[SHOPPER_purpose]=card_registration');
    expect(body).toContain('customParameters[SHOPPER_patientId]=user-1');
  });

  it('ABSENT — a vault MUST NOT send amount, currency, paymentType, or standingInstruction', async () => {
    // The load-bearing "not a purchase" invariant. Peach's docs are
    // explicit that omitting these together indicates registration-
    // only; sending them would turn the vault into a debit.
    const fake = scriptedFetch({ id: 'chk-reg-2' });
    await createCardRegistration({
      merchantTransactionId: 'bnrABCDEFGHIJKLM',
    });
    const body = String(((fake.mock.calls[0] as unknown) as [string, RequestInit])[1].body);
    expect(body).not.toContain('amount=');
    expect(body).not.toContain('currency=');
    expect(body).not.toContain('paymentType=');
    expect(body).not.toContain('standingInstruction');
  });

  it('rejects a merchantTransactionId longer than 16 characters (Visa/MC 3DS2 mandate)', async () => {
    scriptedFetch({ id: 'nope' });
    await expect(createCardRegistration({
      merchantTransactionId: 'this-ref-is-way-too-long-for-16',
    })).rejects.toThrow(/1-16 chars/);
  });

  it('rejects an empty merchantTransactionId', async () => {
    scriptedFetch({ id: 'nope' });
    await expect(createCardRegistration({
      merchantTransactionId: '',
    })).rejects.toThrow(/1-16 chars/);
  });

  it('surfaces Peach 4xx errors with the raw body under PEACH COPYANDPAY ERROR log', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    scriptedFetch({ result: { code: '800.100.156', description: 'transaction declined (format error)' } }, 400);
    await expect(createCardRegistration({
      merchantTransactionId: 'bnrOKOKOKOKOKOK1',
    })).rejects.toThrow();
    const emitted = errSpy.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(emitted).toContain('PEACH COPYANDPAY ERROR');
    expect(emitted).toContain('800.100.156');
    errSpy.mockRestore();
  });
});

// ─── Credential-separation invariant ────────────────────────────────

describe('createCardRegistration — credential-separation invariant', () => {
  it('uses recurring bearer + recurring host — never Checkout V2 OAuth', async () => {
    const fake = scriptedFetch({ id: 'chk-x' });
    await createCardRegistration({ merchantTransactionId: 'bnrABCDEFGHIJKLM' });

    // No OAuth token fetch happens on this path. All calls hit the
    // recurring host.
    for (const call of fake.mock.calls) {
      const url = (call as unknown as [string])[0];
      expect(url).toContain(RECURRING_URL);
      expect(url).not.toContain('/api/oauth/token');
      expect(url).not.toContain('/v2/checkout');
    }
  });
});

// ─── getCardRegistrationStatus ─────────────────────────────────────

describe('getCardRegistrationStatus — GET with entityId query', () => {
  it('GETs the resourcePath with the recurring entity id appended', async () => {
    const fake = scriptedFetch({
      id:                    'peach-payment-1',
      merchantTransactionId: 'bnrABCDEFGHIJKLM',
      result:                { code: '000.100.110', description: 'Successfully processed' },
      registrationId:        'reg-abc',
      card:                  {
        paymentBrand: 'VISA',
        last4Digits:  '4242',
        expiryMonth:  '12',
        expiryYear:   '2030',
        holder:       'Alice Test',
      },
    });
    const status = await getCardRegistrationStatus('/v1/checkouts/chk-x/payment');
    expect(status.status).toBe('success');
    expect(status.registrationId).toBe('reg-abc');
    expect(status.card?.brand).toBe('VISA');
    expect(status.card?.last4).toBe('4242');

    const [url, init] = (fake.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe(`${RECURRING_URL}/v1/checkouts/chk-x/payment?entityId=entity-REC`);
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer recurring-bearer');
  });

  it('normalises a resourcePath missing the leading slash', async () => {
    const fake = scriptedFetch({
      id: 'p1', result: { code: '000.100.110' }, registrationId: 'r1',
      card: { paymentBrand: 'VISA', last4Digits: '4242', expiryMonth: '12', expiryYear: '2030' },
    });
    await getCardRegistrationStatus('v1/checkouts/chk-y/payment'); // no leading slash
    const [url] = (fake.mock.calls[0] as unknown) as [string];
    expect(url).toBe(`${RECURRING_URL}/v1/checkouts/chk-y/payment?entityId=entity-REC`);
  });

  it('appends entityId with & when the resourcePath already carries a query', async () => {
    const fake = scriptedFetch({
      id: 'p1', result: { code: '000.100.110' }, registrationId: 'r1',
      card: { paymentBrand: 'VISA', last4Digits: '4242', expiryMonth: '12', expiryYear: '2030' },
    });
    await getCardRegistrationStatus('/v1/checkouts/chk-z/payment?foo=bar');
    const [url] = (fake.mock.calls[0] as unknown) as [string];
    expect(url).toContain('?foo=bar');
    expect(url).toContain('&entityId=entity-REC');
  });

  it('maps a rejection result code to status=rejected', async () => {
    scriptedFetch({ id: 'p2', result: { code: '800.100.152', description: 'Declined' } });
    const status = await getCardRegistrationStatus('/v1/checkouts/chk-decline/payment');
    expect(status.status).toBe('rejected');
    expect(status.resultDescription).toBe('Declined');
  });
});

// ─── Form-body helper (dotted-name nesting used by customer.*) ──────

describe('__internals.toFormBody — dotted-name nesting for nested objects', () => {
  it('flattens customer.email etc.', () => {
    const body = __internals.toFormBody({
      customer: { email: 'x@y.com', givenName: 'A' },
      standing: null,
    });
    expect(body).toContain('customer.email=x%40y.com');
    expect(body).toContain('customer.givenName=A');
    expect(body).not.toContain('standing=');
  });
});
