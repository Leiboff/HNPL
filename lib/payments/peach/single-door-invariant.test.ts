import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Single-door architecture invariants — grep-shaped pins ────────
//
// Card capture was consolidated onto ONE door: Peach Checkout V2 is
// now EVERY customer-present surface (Flow A pay+tokenise AND Flow B
// save-card, via the zero-amount PA registration recipe). The recurring
// /v1 API stays Flow C MIT only. These pins prove the consolidation
// held and that the retired COPYandPAY door did not leave residue:
//
//   1. Every capture surface (card-add UI + return route) uses the V2
//      PeachWidget + Checkout V2 client — never COPYandPAY.
//   2. Zero COPYandPAY references remain anywhere: the module, the
//      widget, paymentWidgets.js, resourcePath, NEXT_PUBLIC_PEACH_
//      WIDGET_URL are all gone.
//   3. createCardRegistration is reimplemented on the V2 surface (the
//      zero-amount PA recipe), NOT on /v1/checkouts.
//   4. Flow C still and ONLY uses /v1/registrations with the OPPWA
//      standingInstruction source=MIT vocabulary (correct THERE).
//   5. Flow A remains the V2 door it already was.
//
// Cheap source-grep pins — no runtime execution — so they're safe
// regression tripwires for a future refactor that tries to reintroduce
// a second door.

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const CLIENT                  = read('lib/payments/peach/client.ts');
const PROVIDER                = read('lib/payments/provider.ts');
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

// ─── Invariant 1: every capture surface uses the V2 PeachWidget ────

describe('Single door — every capture surface mounts the V2 PeachWidget', () => {
  it('initializeCardRegistration calls provider.createCardRegistration (not createCheckout directly)', () => {
    const fnStart = PATIENT_ACTIONS.indexOf('export async function initializeCardRegistration');
    expect(fnStart).toBeGreaterThan(0);
    const body = PATIENT_ACTIONS.slice(fnStart, fnStart + 3000);
    expect(body).toContain('provider.createCardRegistration');
    // The vault goes through the purpose-built method, never a raw
    // createCheckout with a hand-built amount.
    expect(body).not.toContain('provider.createCheckout(');
  });

  it('PaymentMethods.tsx (card-vault sheet) mounts the V2 PeachWidget', () => {
    expect(PAYMENT_METHODS_UI).toMatch(/from ['"]@\/app\/_components\/PeachWidget['"]/);
    expect(PAYMENT_METHODS_UI).toContain('<PeachWidget');
    expect(PAYMENT_METHODS_UI).not.toContain('PeachCopyAndPayWidget');
  });

  it('ConfirmForm.tsx addCardWidget branch mounts the V2 PeachWidget', () => {
    expect(CONFIRM_FORM).toMatch(/from ['"]@\/app\/_components\/PeachWidget['"]/);
    const addBranch = CONFIRM_FORM.slice(CONFIRM_FORM.indexOf('if (addCardWidget)'));
    expect(addBranch).toContain('<PeachWidget');
    expect(CONFIRM_FORM).not.toContain('PeachCopyAndPayWidget');
  });

  it('card-add return route reads checkoutId + calls provider.getCheckoutStatus (V2), not a resourcePath', () => {
    expect(PAYMENT_METHODS_RETURN).toContain('getCheckoutStatus');
    expect(PAYMENT_METHODS_RETURN).toContain('checkoutId');
    // The retired COPYandPAY status call + its resourcePath must be gone.
    expect(PAYMENT_METHODS_RETURN).not.toContain('getCardRegistrationStatus');
    expect(PAYMENT_METHODS_RETURN).not.toContain('resourcePath');
  });

  it('card-add return route gates on a registration (r) purpose ref — this route only', () => {
    // The card-vault route accepts ONLY 'r' refs; Flow A's completion
    // gates on 'c'. A 'c' ref landing here is a wiring bug.
    expect(PAYMENT_METHODS_RETURN).toContain('peachRefPurpose');
    expect(PAYMENT_METHODS_RETURN).toMatch(/peachRefPurpose\([^)]*\)\s*!==\s*'r'/);
  });

  it('card-add return route still redirects server-side on success (no widget re-entry)', () => {
    expect(PAYMENT_METHODS_RETURN).toContain("from 'next/navigation'");
    expect(PAYMENT_METHODS_RETURN).toMatch(/redirect\(`\/patient\/payment-methods\?added=/);
  });
});

// ─── Invariant 2: COPYandPAY is gone everywhere ────────────────────

describe('Single door — zero COPYandPAY residue remains', () => {
  it('the COPYandPAY module + widget files are deleted', () => {
    expect(existsSync(resolve(ROOT, 'lib/payments/peach/copyandpay/registration.ts'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'app/_components/PeachCopyAndPayWidget.tsx'))).toBe(false);
  });

  it('the provider interface no longer exposes the COPYandPAY vault methods', () => {
    expect(PROVIDER).not.toContain('getCardRegistrationStatus');
    expect(PROVIDER).not.toContain('copyandpay');
    // createCardRegistration survives (reimplemented on V2), but as a
    // V2-door method — no resourcePath vocabulary.
    expect(PROVIDER).toContain('createCardRegistration');
  });

  it('the V2 client carries no COPYandPAY imports, /v1/checkouts paths, or paymentWidgets', () => {
    expect(CLIENT).not.toContain('copyandpay');
    expect(CLIENT).not.toContain('/v1/checkouts');
    expect(CLIENT).not.toContain('paymentWidgets');
    expect(CLIENT).not.toContain('getCardRegistrationStatus');
  });

  it('no source file references paymentWidgets.js or NEXT_PUBLIC_PEACH_WIDGET_URL', () => {
    for (const src of [
      CLIENT, PROVIDER, V2_WIDGET, PATIENT_ACTIONS,
      PAYMENT_METHODS_UI, PAYMENT_METHODS_RETURN, CONFIRM_FORM,
    ]) {
      expect(src).not.toContain('paymentWidgets.js');
      expect(src).not.toContain('NEXT_PUBLIC_PEACH_WIDGET_URL');
    }
  });
});

// ─── Invariant 3: createCardRegistration reimplemented on V2 ────────

describe('Single door — createCardRegistration runs the V2 zero-amount PA recipe', () => {
  it('client.createCardRegistration delegates to createCheckout with the PA registration recipe', () => {
    const fnStart = CLIENT.indexOf('async createCardRegistration');
    expect(fnStart).toBeGreaterThan(0);
    const body = CLIENT.slice(fnStart, fnStart + 900);
    expect(body).toContain('this.createCheckout');
    expect(body).toContain("paymentType:           'PA'");
    expect(body).toContain('createRegistration:    true');
    expect(body).toContain("defaultPaymentMethod:  'CARD'");
    expect(body).toContain('forceDefaultMethod:    true');
    expect(body).toContain('amountCents:           0');
    // A pure vault sends NO standingInstruction.
    expect(body).not.toContain('standingInstruction:');
  });

  it('the createCheckout amount guard admits 0 only under the PA registration recipe', () => {
    expect(CLIENT).toContain('isZeroPaRegistration');
    expect(CLIENT).toMatch(/params\.paymentType === 'PA'/);
    expect(CLIENT).toMatch(/params\.createRegistration === true/);
  });
});

// ─── Invariant 4: Flow C recurring vocabulary stays put ────────────

describe('Flow C — recurring MIT stays on /v1/registrations with OPPWA source=MIT', () => {
  it('chargeInstalment.ts uses provider.chargeSavedCard with source MIT', () => {
    expect(FLOW_C_INSTALMNT).toContain('provider.chargeSavedCard');
    expect(FLOW_C_INSTALMNT).toContain("source: 'MIT'");
  });

  it('settle-actions.ts uses provider.chargeSavedCard with source MIT', () => {
    expect(FLOW_C_SETTLE).toContain('provider.chargeSavedCard');
    expect(FLOW_C_SETTLE).toContain("source: 'MIT'");
  });

  it('the recurring MIT charge path is /v1/registrations/{id}/payments', () => {
    expect(CLIENT).toContain('/v1/registrations/');
  });
});

// ─── Invariant 5: Flow A remains the V2 door it already was ─────────

describe('Flow A — unchanged Checkout V2 door', () => {
  it('Flow A initiateCheckout still uses provider.createCheckout (V2, INSTALLMENT SI)', () => {
    expect(FLOW_A_ACTIONS).toContain('provider.createCheckout');
    expect(FLOW_A_ACTIONS).toMatch(/mode:\s+'INITIAL'/);
    expect(FLOW_A_ACTIONS).toMatch(/type:\s+'INSTALLMENT'/);
  });

  it('Flow A complete route still calls provider.getCheckoutStatus (V2, checkoutId)', () => {
    expect(FLOW_A_COMPLETE).toContain('provider.getCheckoutStatus');
    expect(FLOW_A_COMPLETE).toContain('checkoutId');
  });

  it('Flow A capture surface (ResumeCapture) mounts the V2 PeachWidget; CheckoutForm mounts no widget', () => {
    const RESUME_CAPTURE = read('app/checkout/[token]/ResumeCapture.tsx');
    expect(RESUME_CAPTURE).toMatch(/from ['"]@\/app\/_components\/PeachWidget['"]/);
    expect(RESUME_CAPTURE).not.toContain('PeachCopyAndPayWidget');
    expect(FLOW_A_FORM).not.toMatch(/from ['"]@\/app\/_components\/PeachWidget['"]/);
    expect(FLOW_A_FORM).not.toContain('PeachCopyAndPayWidget');
  });
});
