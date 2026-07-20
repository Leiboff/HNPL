import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Dual-door architecture invariants — grep-shaped pins ──────────
//
// The dual-door design (Checkout V2 for paying, COPYandPAY for
// vaulting) only holds if the "vault" and "pay" call paths cannot
// silently converge. These pins prove three invariants:
//
//   1. Flow B (card-vault UI + action) imports the COPYandPAY widget
//      and calls provider.createCardRegistration — NOT the Checkout
//      V2 createCheckout.
//
//   2. Flow A (paying flows) sources DO NOT import from
//      lib/payments/peach/copyandpay/ — the vault module is
//      quarantined to the card-add path.
//
//   3. The COPYandPAY module has zero cross-imports to Checkout V2:
//      no OAuth env vars, no /v2/checkout paths.
//
// Cheap source-grep pins — no runtime execution — so they're safe
// regression tripwires for a future refactor that accidentally
// merges the doors.

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const COPYANDPAY_REGISTRATION = read('lib/payments/peach/copyandpay/registration.ts');
const COPYANDPAY_WIDGET       = read('app/_components/PeachCopyAndPayWidget.tsx');
const V2_WIDGET               = read('app/_components/PeachWidget.tsx');
const PATIENT_ACTIONS         = read('app/patient/actions.ts');
const PAYMENT_METHODS_UI      = read('app/patient/payment-methods/PaymentMethods.tsx');
const PAYMENT_METHODS_RETURN  = read('app/patient/payment-methods/complete/page.tsx');
const CONFIRM_FORM            = read('app/patient/orders/[planId]/confirm/ConfirmForm.tsx');

// Flow A + Flow C source files — guarantees byte-untouched by this
// pass. The pins below spot-check load-bearing lines. Full byte-
// identity to master is verified independently by `git diff master`
// (documented in the commit report).
const FLOW_A_ACTIONS   = read('app/checkout/[token]/actions.ts');
const FLOW_A_COMPLETE  = read('app/checkout/[token]/complete/page.tsx');
const FLOW_A_FORM      = read('app/checkout/[token]/CheckoutForm.tsx');
const FLOW_C_INSTALMNT = read('lib/payments/chargeInstalment.ts');
const FLOW_C_SETTLE    = read('app/patient/orders/settle-actions.ts');

// ─── Invariant 1: Flow B uses COPYandPAY, not V2 ───────────────────

describe('Flow B (card-vault) — uses COPYandPAY, not Checkout V2', () => {
  it('initializeCardRegistration calls provider.createCardRegistration', () => {
    const fnStart = PATIENT_ACTIONS.indexOf('export async function initializeCardRegistration');
    expect(fnStart).toBeGreaterThan(0);
    const body = PATIENT_ACTIONS.slice(fnStart, fnStart + 3000);
    expect(body).toContain('provider.createCardRegistration');
    // MUST NOT call the paying-flow surface from Flow B.
    expect(body).not.toContain('provider.createCheckout(');
  });

  it('PaymentMethods.tsx (card-vault sheet) mounts PeachCopyAndPayWidget', () => {
    expect(PAYMENT_METHODS_UI).toContain('PeachCopyAndPayWidget');
    // MUST NOT mount the Flow A V2 widget for card-add.
    expect(PAYMENT_METHODS_UI).not.toMatch(/from ['"]@\/app\/_components\/PeachWidget['"]/);
  });

  it('ConfirmForm.tsx addCardWidget branch mounts PeachCopyAndPayWidget', () => {
    // ConfirmForm has BOTH pay-now (Flow A, uses V2 elsewhere) and
    // card-add (Flow B, must be COPYandPAY). The card-add branch
    // imports the COPYandPAY widget.
    expect(CONFIRM_FORM).toContain('PeachCopyAndPayWidget');
    // The addCardWidget JSX mounts the COPYandPAY component, not V2.
    const addBranch = CONFIRM_FORM.slice(CONFIRM_FORM.indexOf('if (addCardWidget)'));
    expect(addBranch).toContain('<PeachCopyAndPayWidget');
  });

  it('card-add return route calls provider.getCardRegistrationStatus (COPYandPAY resourcePath)', () => {
    expect(PAYMENT_METHODS_RETURN).toContain('getCardRegistrationStatus');
    expect(PAYMENT_METHODS_RETURN).toContain('resourcePath');
    // MUST NOT invoke the Checkout V2 status endpoint (allow the
    // string in a comment that explicitly documents non-use).
    expect(PAYMENT_METHODS_RETURN).not.toMatch(/provider\.getCheckoutStatus\(/);
    expect(PAYMENT_METHODS_RETURN).not.toMatch(/await\s+provider\.getCheckoutStatus/);
  });
});

// ─── Invariant 2: COPYandPAY module quarantined from V2 ────────────

describe('COPYandPAY module — zero V2 imports / paths / env vars', () => {
  it('registration.ts references NO Checkout V2 env vars', () => {
    expect(COPYANDPAY_REGISTRATION).not.toContain('PEACH_CHECKOUT_URL');
    expect(COPYANDPAY_REGISTRATION).not.toContain('PEACH_CHECKOUT_CLIENT_ID');
    expect(COPYANDPAY_REGISTRATION).not.toContain('PEACH_CHECKOUT_CLIENT_SECRET');
    expect(COPYANDPAY_REGISTRATION).not.toContain('PEACH_CHECKOUT_MERCHANT_ID');
    expect(COPYANDPAY_REGISTRATION).not.toContain('PEACH_CHECKOUT_ENTITY_ID');
    expect(COPYANDPAY_REGISTRATION).not.toContain('PEACH_AUTH_URL');
  });

  it('registration.ts references NO /v2/checkout paths', () => {
    expect(COPYANDPAY_REGISTRATION).not.toContain('/v2/checkout');
    expect(COPYANDPAY_REGISTRATION).not.toContain('oauth/token');
  });

  it('registration.ts uses the recurring credential family only', () => {
    expect(COPYANDPAY_REGISTRATION).toContain('PEACH_RECURRING_URL');
    expect(COPYANDPAY_REGISTRATION).toContain('PEACH_RECURRING_ENTITY_ID');
    expect(COPYANDPAY_REGISTRATION).toContain('PEACH_RECURRING_ACCESS_TOKEN');
    expect(COPYANDPAY_REGISTRATION).toContain('/v1/checkouts');
  });

  it('COPYandPAY widget uses NEXT_PUBLIC_PEACH_WIDGET_URL (not the V2 checkout.js origin)', () => {
    expect(COPYANDPAY_WIDGET).toContain('NEXT_PUBLIC_PEACH_WIDGET_URL');
    expect(COPYANDPAY_WIDGET).not.toContain('NEXT_PUBLIC_PEACH_CHECKOUT_JS');
    expect(COPYANDPAY_WIDGET).toContain('paymentWidgets.js');
  });

  it('the V2 widget stays purchase-shaped (uses checkout.js), COPYandPAY widget stays vault-shaped', () => {
    // The two components should be visibly distinct.
    expect(V2_WIDGET).toContain('checkout.js');
    expect(V2_WIDGET).not.toContain('paymentWidgets.js');
    expect(COPYANDPAY_WIDGET).toContain('paymentWidgets.js');
    expect(COPYANDPAY_WIDGET).not.toContain('checkout.js');
  });
});

// ─── Invariant 3: Flow A + Flow C are byte-untouched — grep pins ───

describe('Flow A + Flow C — load-bearing lines still present', () => {
  it('Flow A initiateCheckout still uses provider.createCheckout (V2)', () => {
    expect(FLOW_A_ACTIONS).toContain('provider.createCheckout');
    expect(FLOW_A_ACTIONS).toMatch(/mode:\s+'INITIAL'/);
    expect(FLOW_A_ACTIONS).toMatch(/type:\s+'INSTALLMENT'/);
    // Sanity: Flow A never touches the vault surface.
    expect(FLOW_A_ACTIONS).not.toContain('createCardRegistration');
  });

  it('Flow A complete route still calls provider.getCheckoutStatus (V2)', () => {
    expect(FLOW_A_COMPLETE).toContain('provider.getCheckoutStatus');
    // Flow A complete DOES NOT read a resourcePath — it takes a
    // checkoutId directly from the V2 return.
    expect(FLOW_A_COMPLETE).toContain('checkoutId');
  });

  it('Flow A CheckoutForm still imports the V2 PeachWidget', () => {
    expect(FLOW_A_FORM).toMatch(/from ['"]@\/app\/_components\/PeachWidget['"]/);
    expect(FLOW_A_FORM).not.toContain('PeachCopyAndPayWidget');
  });

  it('Flow C chargeInstalment.ts still uses provider.chargeSavedCard (recurring MIT)', () => {
    expect(FLOW_C_INSTALMNT).toContain('provider.chargeSavedCard');
    expect(FLOW_C_INSTALMNT).toContain("source: 'MIT'");
  });

  it('Flow C settle-actions.ts still uses provider.chargeSavedCard', () => {
    expect(FLOW_C_SETTLE).toContain('provider.chargeSavedCard');
    expect(FLOW_C_SETTLE).toContain("source: 'MIT'");
  });
});
