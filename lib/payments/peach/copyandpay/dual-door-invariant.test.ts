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

  it('card-add return route uses server-side redirect on success (no re-entry into widget)', () => {
    // Server-side `redirect(...)` throws NEXT_REDIRECT — the browser
    // navigates to /patient/payment-methods without a client-side
    // link click. Guards against the perceived "widget loop" where
    // a broken success path re-rendered the failure card.
    expect(PAYMENT_METHODS_RETURN).toContain("from 'next/navigation'");
    expect(PAYMENT_METHODS_RETURN).toMatch(/redirect\(`\/patient\/payment-methods\?added=/);
  });

  it('payWithSavedCard emits the diagnostic request/response log (2026-07-20b)', () => {
    // When a plan stalls on "Charging…" the log tells us WHY:
    //   PEACH PAY-WITH-SAVED-CARD REQUEST:  registrationId + amount
    //   PEACH PAY-WITH-SAVED-CARD RESPONSE: status + resultCode
    // A null/empty token here would immediately explain a stall
    // caused by a plan whose peach_registration_id never got
    // populated (upstream widget failure).
    expect(PATIENT_ACTIONS).toContain('PEACH PAY-WITH-SAVED-CARD REQUEST:');
    expect(PATIENT_ACTIONS).toContain('PEACH PAY-WITH-SAVED-CARD RESPONSE:');
  });

  it('payWithSavedCard wraps DB-write region in try/catch with rollback (2026-07-21 fix)', () => {
    // Root cause of the perpetual "Charging…" state: no safety net
    // between the payment INSERT (status='processing') and the
    // chargeSavedCard call. Any throw or timeout in that window
    // left the plan at pending_first_payment with an orphan
    // processing payment row and no charge attempt.
    //
    // The fix:
    //   • try/catch wrapping the whole write region
    //   • rollbackPlanState() helper that deletes payments + resets
    //     the plan to pending_acceptance
    //   • step-tagged logs (STEP 1 .. STEP 6) so a future stall is
    //     unambiguous in Vercel logs
    //   • empty-token short-circuit so a null registrationId returns
    //     an actionable error instead of a Peach 404 stall
    expect(PATIENT_ACTIONS).toContain('rollbackPlanState');
    expect(PATIENT_ACTIONS).toContain('PEACH PAY-WITH-SAVED-CARD UNCAUGHT:');
    expect(PATIENT_ACTIONS).toContain('PEACH PAY-WITH-SAVED-CARD STEP 1 PLAN UPDATE');
    expect(PATIENT_ACTIONS).toContain('PEACH PAY-WITH-SAVED-CARD STEP 2 PAYMENTS INSERT');
    expect(PATIENT_ACTIONS).toContain('PEACH PAY-WITH-SAVED-CARD STEP 3 REF STAMP');
    expect(PATIENT_ACTIONS).toContain('PEACH PAY-WITH-SAVED-CARD ROLLBACK:');
    // Empty-token short-circuit: match the specific catch-and-rollback
    // pattern, not the same string in a code comment.
    expect(PATIENT_ACTIONS).toMatch(/if\s*\(!paymentMethod\.token\)/);
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

  it('COPYandPAY widget hides the dated brand-chip row (defect 3 fix)', () => {
    // Brand detection stays on (BIN-based); the visual chips are
    // hidden via page CSS since paymentWidgets renders them outside
    // its own iframe.
    expect(COPYANDPAY_WIDGET).toContain('brandDetection: true');
    // Docs recipe classes for hiding the brand-selector row.
    expect(COPYANDPAY_WIDGET).toContain('.wpwl-wrapper-brand');
    expect(COPYANDPAY_WIDGET).toContain('.wpwl-label-brand');
    expect(COPYANDPAY_WIDGET).toContain('display: none');
  });

  it('COPYandPAY widget skins the submit button with our brand gradient (defect 3 fix)', () => {
    expect(COPYANDPAY_WIDGET).toContain('.wpwl-button-pay');
    expect(COPYANDPAY_WIDGET).toContain('#13294B');
    expect(COPYANDPAY_WIDGET).toContain('#15A89E');
  });

  it('COPYandPAY widget SCOPES the form to card brands via data-brands (defect-fix 2026-07-20b)', () => {
    // Corrects the 2026-07-20a pass: dropping data-brands entirely
    // did NOT enable auto-detect; it removed the brand scope and
    // caused paymentWidgets to fall back to its default catalogue
    // (Visa, MC, SEPA, iDEAL, WERO, COD, Deutschland, ...) plus
    // logging "No brands defined, displaying default brands".
    //
    // Correct config: data-brands PRESENT scopes to card brands,
    // brandDetection PRESENT makes selection automatic within scope,
    // the .wpwl-wrapper-brand CSS below hides any residual UI.
    //
    // Strip line/block comments so the pin measures actual JSX.
    const stripped = COPYANDPAY_WIDGET
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    // data-brands must be on the form element (JSX attribute form).
    expect(stripped).toMatch(/data-brands\s*=/);
    // Scope must include at least Visa + Mastercard (the docs' widget
    // tokens are uppercase VISA / MASTER, whitespace-separated).
    expect(stripped).toMatch(/VISA/);
    expect(stripped).toMatch(/MASTER/);
    // brandDetection stays on — that's what suppresses the manual
    // dropdown when the scope contains 2+ brands.
    expect(stripped).toMatch(/brandDetection:\s*true/);
    // No non-card brand tokens slip into the scope. Presence of
    // 'SEPA'/'IDEAL'/'WERO'/'COD' in this file would indicate the
    // brand list has expanded beyond cards (and the widget would
    // surface those payment methods again).
    expect(stripped).not.toMatch(/\bSEPA\b/);
    expect(stripped).not.toMatch(/\bIDEAL\b/);
    expect(stripped).not.toMatch(/\bWERO\b/);
    expect(stripped).not.toMatch(/\bCOD\b/);
  });

  it('COPYandPAY widget hides the residual brand selector row (belt-and-braces CSS)', () => {
    // Detection ON + 2+ brands in scope still lets some widget
    // builds render a hidden wrapper; the docs' recipe explicitly
    // hides it so no picker footprint remains.
    expect(COPYANDPAY_WIDGET).toContain('.wpwl-wrapper-brand');
    expect(COPYANDPAY_WIDGET).toContain('.wpwl-label-brand');
    expect(COPYANDPAY_WIDGET).toContain('display: none');
  });

  it('COPYandPAY widget configures iframeStyles + .wpwl-control-iframe height (defect 2 fix)', () => {
    // Documented iframeStyles keys — placeholder styling inside the
    // PCI iframe. Presence proves we're crossing the PCI boundary
    // for placeholder color / font.
    expect(COPYANDPAY_WIDGET).toContain('iframeStyles');
    expect(COPYANDPAY_WIDGET).toContain("'card-number-placeholder'");
    expect(COPYANDPAY_WIDGET).toContain("'cvv-placeholder'");
    // Outer wrapper height — the only lever we have to keep typed
    // digits from being clipped, since Peach doesn't expose height
    // inside the iframe. Matches either a literal px value or a
    // template-literal reference to the height constant, since
    // grepping reads raw source (no template interpolation).
    expect(COPYANDPAY_WIDGET).toContain('.wpwl-control-iframe');
    expect(COPYANDPAY_WIDGET).toMatch(/min-height:\s*(?:\d+px|\$\{[A-Z_]+MIN_HEIGHT[A-Z_]*\}px)/);
    // And the constant itself must be a sensible pixel value.
    expect(COPYANDPAY_WIDGET).toMatch(/IFRAME_MIN_HEIGHT_PX\s*=\s*(3[6-9]|4\d|5\d)\b/);
  });

  it('the V2 widget stays purchase-shaped (uses checkout.js), COPYandPAY widget stays vault-shaped', () => {
    // The two components should be visibly distinct.
    expect(V2_WIDGET).toContain('checkout.js');
    expect(V2_WIDGET).not.toContain('paymentWidgets.js');
    expect(COPYANDPAY_WIDGET).toContain('paymentWidgets.js');
    expect(COPYANDPAY_WIDGET).not.toContain('checkout.js');
  });
});

// ─── Fix pin: registration-only response shape handling ────────────
//
// Defect 1 fix — pickRegistrationId must fall back to `body.id` for
// a registration-only response (which has no separate
// `registrationId` field per Peach docs). These pins protect against
// a re-regression to the "only reads registrationId" behaviour that
// caused the widget-loop.

describe('registration.ts — registration-only response fallback (Defect 1 fix)', () => {
  it('exports pickRegistrationId + toPaymentStatus for testing', () => {
    expect(COPYANDPAY_REGISTRATION).toContain('pickRegistrationId');
    expect(COPYANDPAY_REGISTRATION).toContain('toPaymentStatus');
  });

  it('pickRegistrationId body falls back to body.id when registrationId is absent', () => {
    // Grep for the fallback pattern — source-shape pin.
    const fnStart = COPYANDPAY_REGISTRATION.indexOf('function pickRegistrationId');
    expect(fnStart).toBeGreaterThan(0);
    const body = COPYANDPAY_REGISTRATION.slice(fnStart, fnStart + 600);
    // Prefer registrationId first.
    expect(body).toContain('body.registrationId');
    // Fall back to body.id under a registration-only shape guard.
    expect(body).toContain('body.id');
  });

  it('return route logs the raw response under the greppable PEACH REG STATUS tag', () => {
    expect(COPYANDPAY_REGISTRATION).toContain('PEACH REG STATUS RESPONSE');
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

  it('Flow A capture surface (ResumeCapture) mounts the V2 PeachWidget, not COPYandPAY', () => {
    // The V2 widget host for Flow A moved from CheckoutForm to
    // ResumeCapture: CheckoutForm now hands off to the single
    // confirm+widget surface (page.tsx → ResumeCapture) after
    // initiateCheckout, so there's exactly ONE confirm before the
    // widget. Either way the widget MUST be the Checkout V2 one, never
    // the Flow B COPYandPAY widget.
    const RESUME_CAPTURE = read('app/checkout/[token]/ResumeCapture.tsx');
    expect(RESUME_CAPTURE).toMatch(/from ['"]@\/app\/_components\/PeachWidget['"]/);
    expect(RESUME_CAPTURE).not.toContain('PeachCopyAndPayWidget');
    // And CheckoutForm no longer mounts a widget itself (single confirm).
    expect(FLOW_A_FORM).not.toMatch(/from ['"]@\/app\/_components\/PeachWidget['"]/);
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
