import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── V2 card-save fixes — source-text pins ──────────────────────────
//
// Two systemic bugs are locked here:
//
//   FIX 1 — paymentBrand read from the wrong shape. Peach returns
//   paymentBrand at the TOP LEVEL (sibling of `card`), NOT
//   card.paymentBrand. Every card since the Peach swap saved as brand
//   "Card" + signature NULL → dedup globally broken. All FOUR save
//   paths must read top-level paymentBrand first, with card.paymentBrand
//   as a tolerant fallback: the shared V2 status parser (toPaymentStatus,
//   which feeds the plan-acceptance / add-card / Flow-A cold-checkout
//   completion routes) + BOTH webhook save sites. last4/expiry stay read
//   from card.last4Digits / card.expiryMonth / card.expiryYear.
//
//   FIX 2 — the add-card completion route's idempotency guard was keyed
//   on patient_id + a 5-minute time window, so a legitimate SECOND card
//   added within 5 minutes matched the FIRST card and returned before
//   saving. It must be scoped to THIS checkout's registrationId (the row
//   token actually being saved) so a new card inserts while a same-
//   checkout re-post still no-ops.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const CLIENT        = read('lib/payments/peach/client.ts');
const WEBHOOK_ROUTE = read('app/api/payments/peach/webhook/route.ts');
const ADD_CARD      = read('app/patient/payment-methods/complete/page.tsx');
const FLOW_A        = read('app/checkout/[token]/complete/page.tsx');
const PLAN_ACCEPT   = read('app/patient/payment-complete/page.tsx');

// ─── FIX 1 — brand read, all four save paths ───────────────────────

describe('FIX 1 — paymentBrand read top-level first, on every save path', () => {
  it('toPaymentStatus (shared V2 parser) reads top-level paymentBrand ?? card.paymentBrand', () => {
    expect(CLIENT).toMatch(
      /pickStr\(body,\s*'paymentBrand'\)\s*\?\?\s*pickStr\(body,\s*'card\.paymentBrand'\)/,
    );
  });

  it('the shared parser still reads last4/expiry from the card object (unchanged)', () => {
    expect(CLIENT).toContain("pickStr(body, 'card.last4Digits')");
    expect(CLIENT).toContain("pickStr(body, 'card.expiryMonth')");
    expect(CLIENT).toContain("pickStr(body, 'card.expiryYear')");
  });

  it('BOTH webhook save sites read payload.paymentBrand ?? payload.card.paymentBrand', () => {
    const hits = WEBHOOK_ROUTE.match(
      /brand:\s*payload\.paymentBrand\s*\?\?\s*payload\.card\.paymentBrand\s*\?\?\s*null/g,
    );
    expect(hits).not.toBeNull();
    expect(hits!.length).toBe(2);
  });

  it('the old (buggy) card.paymentBrand-only read is gone from the webhook route', () => {
    expect(WEBHOOK_ROUTE).not.toMatch(/brand:\s*payload\.card\.paymentBrand\s*\?\?\s*null/);
  });

  it('webhook last4/expiry still read from card.last4Digits / card.expiry*', () => {
    expect(WEBHOOK_ROUTE).toContain('payload.card.last4Digits');
    expect(WEBHOOK_ROUTE).toContain('payload.card.expiryMonth');
    expect(WEBHOOK_ROUTE).toContain('payload.card.expiryYear');
  });

  it('Flow A cold-checkout completion saves via the shared parser (status.card.brand)', () => {
    expect(FLOW_A).toContain('saveCardForPatient');
    expect(FLOW_A).toMatch(/brand:\s*status\.card\.brand\s*\?\?\s*null/);
  });

  it('plan-acceptance (saved-card CIT) completion saves via the shared parser too', () => {
    expect(PLAN_ACCEPT).toContain('saveCardForPatient');
    expect(PLAN_ACCEPT).toMatch(/brand:\s*status\.card\.brand\s*\?\?\s*null/);
  });
});

// ─── FIX 2 — scoped add-card idempotency ───────────────────────────

describe('FIX 2 — add-card idempotency scoped to THIS checkout, not a time window', () => {
  it('the old "any card in the last 5 minutes" fast-path is removed', () => {
    // The guard used `.gte('created_at', since)` against payment_methods.
    expect(ADD_CARD).not.toMatch(/payment_methods[\s\S]{0,200}\.gte\('created_at',\s*since\)/);
  });

  it('idempotency is now keyed on the row token === this checkout registrationId', () => {
    expect(ADD_CARD).toMatch(/\.from\('payment_methods'\)[\s\S]{0,200}\.eq\('token',\s*status\.registrationId\)/);
  });

  it('a match short-circuits to SuccessCard; otherwise it falls through to save', () => {
    expect(ADD_CARD).toMatch(/if\s*\(alreadyOnFile\)\s*\{[\s\S]{0,160}<SuccessCard/);
    expect(ADD_CARD).toContain('const result = await saveCardForPatient(');
  });
});
