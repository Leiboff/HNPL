import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Phase 4 (4b + 4c) — source guards ──────────────────────────────────
//
// 4b: the "Try again" affordance on the card-verification result screens
//     must RE-LAUNCH a fresh add-card flow, not re-poll a finished checkout.
// 4c: the card-entry surfaces must use card-VERIFICATION language, never
//     payment language, on what is a zero-amount registration.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const COMPLETE  = read('app/patient/payment-methods/complete/page.tsx');
const POLLING   = read('app/patient/payment-methods/complete/PollingConfirmation.tsx');
const PM_CLIENT = read('app/patient/payment-methods/PaymentMethods.tsx');
const CONFIRM   = read('app/patient/orders/[planId]/confirm/ConfirmForm.tsx');

describe('4b — "Try again" re-launches instead of re-polling', () => {
  it('the completion FailureCard retry points at a fresh add-card, not a checkout re-poll', () => {
    expect(COMPLETE).toContain('cardRetryDestination()');
    expect(COMPLETE).not.toMatch(/\/patient\/payment-methods\/complete\?checkoutId=/);
  });

  it('the polling timeout retry points at a fresh add-card, not a checkout re-poll', () => {
    expect(POLLING).toContain('cardRetryDestination()');
    expect(POLLING).not.toMatch(/\/patient\/payment-methods\/complete\?checkoutId=/);
  });

  it('the card surface auto-opens the widget when returned to with the retry flag', () => {
    expect(PM_CLIENT).toMatch(/from '@\/lib\/patient\/cardReturn'/);
    expect(PM_CLIENT).toContain('searchParams.get(ADD_CARD_PARAM)');
    expect(PM_CLIENT).toContain('void handleAddCard()');
  });
});

describe('4c — card-entry copy is verification language, not payment language', () => {
  const NO_PAYMENT_WORDING = [
    'Pay now',
    'complete the payment',
    'cancel the transaction',
    'Complete payment',
  ];

  it('the Account add-card panel uses no-charge verification copy', () => {
    expect(PM_CLIENT).toContain('no money is taken');
    for (const phrase of NO_PAYMENT_WORDING) expect(PM_CLIENT).not.toContain(phrase);
  });

  it('the confirm-flow add-card panel uses no-charge verification copy', () => {
    expect(CONFIRM).toContain('no money is taken');
    expect(CONFIRM).toContain('add it to your account');
    for (const phrase of NO_PAYMENT_WORDING) expect(CONFIRM).not.toContain(phrase);
  });
});
