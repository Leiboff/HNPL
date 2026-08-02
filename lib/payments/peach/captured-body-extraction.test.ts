import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { __resetPeachTokenCache, PeachProvider, pickField, __internals } from './client';
import { classifyResultCode } from './resultCodes';
import { parseFormEventBody } from './webhook';
import { peachRefPurpose, checkoutRef, registrationRef } from './refs';
import { fingerprintForCard } from './saveCardForPatient';
import {
  V2_STATUS_FLAT_0EA3,
  V2_STATUS_FLAT_03E9,
  V2_STATUS_TOP_LEVEL_BRAND,
  V2_STATUS_BOTH_BRANDS,
  V2_STATUS_NESTED,
  V2_STATUS_DECLINE,
  V2_STATUS_CIT_1DCF,
  V1_MIT_CHARGE_ACCEPTED,
  CIT_CHAIN_ROOT_ID,
  RESULT_CODES,
  WEBHOOK_PAYMENT_SUCCESS,
  WEBHOOK_CARD_REG,
  WEBHOOK_REGISTRATION_DELETED,
  WEBHOOK_MIT_SI,
  V1_MIT_CHARGE_RESPONSE,
  V1_REFUND_RESPONSE,
} from './__fixtures__/capturedBodies';

// ─── Peach captured-body extraction suite ───────────────────────────
//
// Pins EVERY Peach field extraction against the REAL response shapes
// (see __fixtures__/capturedBodies.ts for provenance). This is the
// regression net for the five historical field-shape bugs (B1–B5) — if
// any is reintroduced, a test here fails. Fields with no captured body
// yet (the CIT chain-root scheme ids) are written as skipped tests
// asserting the documented shape, marked AWAITING LIVE CAPTURE (Phase 2).

const toPaymentStatus = __internals.toPaymentStatus;

// ─── 1. classifyResultCode — B1 (charged-review family) ─────────────

describe('classifyResultCode — real result-code families', () => {
  it('classic success families → success', () => {
    for (const c of RESULT_CODES.success) expect(classifyResultCode(c)).toBe('success');
  });

  it('B1: 000.400.0xx "charged, manual-review" family → success (NOT decline)', () => {
    // The exact bug: these fell through to 'rejected' and a captured
    // first instalment showed "card declined".
    for (const c of RESULT_CODES.chargedReview) expect(classifyResultCode(c)).toBe('success');
  });

  it('000.400.03x + genuine 3DS failures → rejected', () => {
    for (const c of RESULT_CODES.declines3ds) expect(classifyResultCode(c)).toBe('rejected');
  });

  it('pending families → pending (never a decline verdict)', () => {
    for (const c of RESULT_CODES.pending) expect(classifyResultCode(c)).toBe('pending');
  });

  it('declines + missing code → rejected', () => {
    for (const c of RESULT_CODES.rejected) expect(classifyResultCode(c)).toBe('rejected');
    expect(classifyResultCode(undefined)).toBe('rejected');
    expect(classifyResultCode(null)).toBe('rejected');
  });
});

// ─── 2. toPaymentStatus — B2 (flat) + B4 (top-level brand) ──────────

describe('toPaymentStatus — real FLAT prod status body (0ea34011…)', () => {
  const st = toPaymentStatus(V2_STATUS_FLAT_0EA3);

  it('B2: reads result.code FLAT → success (nested-only read would be "rejected")', () => {
    expect(st.status).toBe('success');
    expect(st.resultCode).toBe('000.100.110');
  });

  it('extracts id / merchantTransactionId / amount / registrationId from flat keys', () => {
    expect(st.providerPaymentId).toBe('pay-flat-0ea3');
    expect(st.merchantTransactionId).toBe('bnc2b23vwkixm97y');
    expect(st.amountCents).toBe(9200);
    expect(st.registrationId).toBe('8ac7a49f9fb7fec7019fbf26b73e7852');
  });

  it('extracts card.last4Digits / expiry / holder from card.* flat keys', () => {
    expect(st.card?.last4).toBe('0042');
    expect(st.card?.expiryMonth).toBe(12);
    expect(st.card?.expiryYear).toBe(2030);
    expect(st.card?.holder).toBe('Jane Doe');
  });
});

describe('toPaymentStatus — NESTED twin parses identically (both shapes tolerated)', () => {
  const st = toPaymentStatus(V2_STATUS_NESTED);
  it('nested result.code + card.* read the same values', () => {
    expect(st.status).toBe('success');
    expect(st.registrationId).toBe('8ac7a49f9fb7fec7019fbf26b73e7852');
    expect(st.card?.last4).toBe('0042');
    expect(st.card?.brand).toBe('VISA');
  });
});

describe('toPaymentStatus — B4: paymentBrand placement', () => {
  it('reads brand from the TOP-LEVEL paymentBrand (documented placement)', () => {
    const st = toPaymentStatus(V2_STATUS_TOP_LEVEL_BRAND);
    expect(st.card?.brand).toBe('VISA');
    expect(st.card?.last4).toBe('0042');
  });

  it('top-level paymentBrand WINS over a nested card.paymentBrand', () => {
    const st = toPaymentStatus(V2_STATUS_BOTH_BRANDS);
    expect(st.card?.brand).toBe('VISA');
  });

  it('falls back to nested card.paymentBrand on the real capture (no top-level)', () => {
    // V2_STATUS_FLAT_0EA3 carries only card.paymentBrand.
    expect(toPaymentStatus(V2_STATUS_FLAT_0EA3).card?.brand).toBe('VISA');
  });
});

describe('toPaymentStatus — decline body', () => {
  it('800.100.152 → rejected, no card', () => {
    const st = toPaymentStatus(V2_STATUS_DECLINE);
    expect(st.status).toBe('rejected');
    expect(st.card).toBeUndefined();
  });
});

// ─── 3. customParameters — bracketed-flat (finding #4 / P2) ─────────

describe('V2 status customParameters — REAL bracketed-flat shape (03e9c095…)', () => {
  it('customParameters arrive as bracketed-flat keys, NOT a nested object', () => {
    // This is the exact shape the completion route + webhook must read.
    expect(V2_STATUS_FLAT_03E9['customParameters[SHOPPER_patientId]']).toBe('usr-1');
    // pickField reads the literal bracketed key (what the sync page does).
    expect(pickField(V2_STATUS_FLAT_03E9, 'customParameters[SHOPPER_patientId]')).toBe('usr-1');
  });

  it('a NESTED customParameters read returns undefined against the real shape', () => {
    // Documents finding #4: reading `.customParameters.SHOPPER_patientId`
    // (nested) does NOT resolve — the webhook backstop bug. Phase 5 fixes
    // the reader; this pins WHY.
    expect((V2_STATUS_FLAT_03E9 as { customParameters?: Record<string, string> }).customParameters).toBeUndefined();
  });
});

// ─── 4. parseFormEventBody — webhook shapes ─────────────────────────

describe('parseFormEventBody — real webhook shapes', () => {
  it('PAYMENT event: unflattens result.code + card.* (dotted → nested)', () => {
    const p = parseFormEventBody(WEBHOOK_PAYMENT_SUCCESS)!;
    expect(p.type).toBe('PAYMENT');
    const pay = p.payload as { result?: { code?: string }; card?: { last4Digits?: string; paymentBrand?: string }; registrationId?: string };
    expect(pay.result?.code).toBe('000.100.110');
    expect(pay.card?.last4Digits).toBe('4242');
    expect(pay.card?.paymentBrand).toBe('VISA');
    expect(pay.registrationId).toBe('peach-reg-abc');
  });

  it('MIT event: standingInstruction.initialTransactionId (dotted) → nested', () => {
    const p = parseFormEventBody(WEBHOOK_MIT_SI)!;
    const pay = p.payload as { standingInstruction?: { initialTransactionId?: string } };
    expect(pay.standingInstruction?.initialTransactionId).toBe('CIT-ROOT-1');
  });

  it('card-reg event: customParameters stay BRACKETED-FLAT (not nested)', () => {
    // The parser splits on '.', so `customParameters[SHOPPER_patientId]`
    // (no dot) remains a single flat key. This is why the nested read in
    // the webhook backstop misses it (finding #4 / P2, fixed Phase 5).
    const p = parseFormEventBody(WEBHOOK_CARD_REG)!;
    const pay = p.payload as Record<string, unknown> & { customParameters?: Record<string, string> };
    expect(pay['customParameters[SHOPPER_patientId]']).toBe('patient-1');
    expect(pay.customParameters).toBeUndefined();
  });

  it('REGISTRATION DELETED event: type + action + id', () => {
    const p = parseFormEventBody(WEBHOOK_REGISTRATION_DELETED)!;
    expect(p.type).toBe('REGISTRATION');
    expect(p.action).toBe('DELETED');
    expect((p.payload as { id?: string }).id).toBe('reg-1');
  });
});

// ─── 5. refs — B3 (compact ref recognised, legacy null) ─────────────

describe('peach refs — compact 16-char scheme (B3)', () => {
  it('a real captured checkout ref resolves to purpose "c"', () => {
    // bnc2b23vwkixm97y is a real prod ref.
    expect(peachRefPurpose('bnc2b23vwkixm97y')).toBe('c');
  });

  it('B3: a legacy hnpl_co_ ref is NOT a compact ref (returns null)', () => {
    // The bug treated compact refs as legacy via startsWith('hnpl_co_');
    // the purpose recogniser is the correct gate.
    expect(peachRefPurpose('hnpl_co_0123456789abcdef0123')).toBeNull();
  });

  it('checkoutRef / registrationRef mint deterministic 16-char refs with the right purpose', () => {
    const c = checkoutRef('payment-uuid-1');
    expect(c).toHaveLength(16);
    expect(peachRefPurpose(c)).toBe('c');
    expect(checkoutRef('payment-uuid-1')).toBe(c); // deterministic
    expect(peachRefPurpose(registrationRef('nonce-1'))).toBe('r');
  });
});

// ─── 6. fingerprintForCard — B4 downstream (real signature) ─────────

describe('fingerprintForCard — real card fields → non-null signature (B4)', () => {
  it('VISA / 0042 / 02-2031 → peach:VISA:0042:022031', () => {
    expect(fingerprintForCard({ brand: 'VISA', last4: '0042', expiryMonth: 2, expiryYear: 2031 }))
      .toBe('peach:VISA:0042:022031');
  });
  it('the B4 failure input (brand absent) → null signature', () => {
    expect(fingerprintForCard({ brand: null, last4: '0042', expiryMonth: 2, expiryYear: 2031 })).toBeNull();
  });
});

// ─── 7. /v1 recurring charge + refund — nested extraction ───────────

const RECURRING_URL = 'https://recurring.test';
const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetPeachTokenCache();
  process.env.PEACH_RECURRING_URL          = RECURRING_URL;
  process.env.PEACH_RECURRING_ENTITY_ID    = 'entity-REC';
  process.env.PEACH_RECURRING_ACCESS_TOKEN = 'recurring-bearer';
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  __resetPeachTokenCache();
});

function respondOnce(body: unknown, status = 200) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

describe('chargeSavedCard — NESTED /v1 MIT response extraction', () => {
  it('reads result.code, id, and the standingInstruction.initialTransactionId echo', async () => {
    respondOnce(V1_MIT_CHARGE_RESPONSE);
    const res = await new PeachProvider().chargeSavedCard({
      registrationId:        'reg-1',
      amountCents:           9200,
      merchantTransactionId: 'bni0123456789abc',
      currency:              'ZAR',
      standingInstruction:   { mode: 'REPEATED', source: 'MIT', type: 'INSTALLMENT', initialTransactionId: 'CIT-ROOT-1' },
    });
    expect(res.status).toBe('success');
    expect(res.providerPaymentId).toBe('pay-mit-1');
    expect(res.resultCode).toBe('000.100.110');
    expect(res.initialTransactionId).toBe('CIT-ROOT-1');
  });
});

describe('refund — NESTED /v1 response extraction', () => {
  it('reads result.code + id', async () => {
    respondOnce(V1_REFUND_RESPONSE);
    const res = await new PeachProvider().refund('pay-mit-1', 9200, 'bnr0123456789abc');
    expect(res.status).toBe('success');
    expect(res.providerRefundId).toBe('refund-1');
    expect(res.resultCode).toBe('000.100.110');
  });
});

// ─── 8. CIT chain root — RESOLVED by live capture (Phase 2) ─────────
//
// Live sandbox MIT (2026-08-02, checkout 1dcf373f…) proved: the CIT
// top-level `id` is the chain root, Peach returns NO scheme ids on this
// integration, and the MIT was ACCEPTED with that id as
// standingInstruction.initialTransactionId. These are now ACTIVE pins.

describe('CIT chain root — the top-level `id` (proven by live MIT)', () => {
  it('toPaymentStatus surfaces the CIT `id` as providerPaymentId — the value we stamp', () => {
    // payment-complete/page.tsx + checkout/[token]/complete/page.tsx stamp
    // plans.peach_initial_transaction_id = status.providerPaymentId.
    const st = toPaymentStatus(V2_STATUS_CIT_1DCF);
    expect(st.providerPaymentId).toBe(CIT_CHAIN_ROOT_ID);
    expect(st.status).toBe('success');
  });

  it('the real CIT body carries NO cardholderInitiatedTransactionId / schemeTransactionId', () => {
    // REGRESSION GUARD: a refactor that "reads the documented scheme id"
    // would read undefined here and silently break every MIT chain. This
    // pins that those fields are ABSENT on this integration.
    expect(pickField(V2_STATUS_CIT_1DCF, 'cardholderInitiatedTransactionId')).toBeUndefined();
    expect(pickField(V2_STATUS_CIT_1DCF, 'schemeTransactionId')).toBeUndefined();
  });

  it('the ACCEPTED MIT echoed our sent initialTransactionId (== the CIT id) and succeeded', () => {
    respondOnce(V1_MIT_CHARGE_ACCEPTED);
    return new PeachProvider().chargeSavedCard({
      registrationId:        'reg-1dcf373f',
      amountCents:           9200,
      merchantTransactionId: 'bni1dcf373fcapt',
      currency:              'ZAR',
      standingInstruction:   { mode: 'REPEATED', source: 'MIT', type: 'INSTALLMENT', initialTransactionId: CIT_CHAIN_ROOT_ID },
    }).then((res) => {
      expect(res.status).toBe('success');
      expect(res.resultCode).toBe('000.100.110');
      expect(res.initialTransactionId).toBe(CIT_CHAIN_ROOT_ID);
    });
  });

  it('the MIT standing-instruction WE SEND matches the accepted shape', () => {
    // Source-pin: chargeInstalment builds the exact SI Peach accepted —
    // REPEATED / MIT / INSTALLMENT + initialTransactionId (with the
    // UNSCHEDULED fallback only when no root is stamped yet).
    const src = readFileSync(resolve(process.cwd(), 'lib/payments/chargeInstalment.ts'), 'utf8');
    expect(src).toMatch(/mode:\s*'REPEATED'[\s\S]{0,60}source:\s*'MIT'[\s\S]{0,80}type:\s*'INSTALLMENT'[\s\S]{0,60}initialTransactionId:\s*initial/);
    expect(src).toMatch(/type:\s*'UNSCHEDULED'/); // fallback branch retained
  });
});

// ─── 9. B5 guard — add-card idempotency scoped to the checkout ──────
//
// Not a body-extraction, but the fifth historical bug. Source-pinned
// here so the whole five-bug set fails against reintroduction in ONE
// suite. (Behavioural detail lives in v2-card-brand-and-idempotency.test.ts.)

describe('B5 — add-card idempotency is scoped to the checkout registrationId', () => {
  const ADD_CARD = readFileSync(
    resolve(process.cwd(), 'app/patient/payment-methods/complete/page.tsx'),
    'utf8',
  );
  it('keys idempotency on token === status.registrationId, not a time window', () => {
    expect(ADD_CARD).toMatch(/\.eq\('token',\s*status\.registrationId\)/);
    expect(ADD_CARD).not.toMatch(/payment_methods[\s\S]{0,200}\.gte\('created_at',\s*since\)/);
  });
});
