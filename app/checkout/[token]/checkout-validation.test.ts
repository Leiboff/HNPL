import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Checkout form validation parity with signup ──────────────────────────
//
// Source-text regression that pins the SHARED validation surface.
// Three invariants worth locking down because every one of them, if
// broken, recreates a real UX bug we've already fixed in signup:
//
//   1. CheckoutForm imports useFieldValidation from the same shared
//      lib that PatientSignupForm + PracticeSignupPage import from —
//      i.e. there is no parallel validation hook in checkout.
//   2. SA ID / phone / firstName / lastName / terms are wired through
//      that hook with `onBlur={onBlur(...)}` AND `onChange={setText(...)}`,
//      matching the signup pattern exactly.
//   3. The validators come from `@/lib/validation` (validateSaId,
//      saIdAge, normalizePhoneZA) — no inline regex / no local
//      reimplementation.
//
// Email is read-only on this form (the invitation pre-fills it; the
// emailed-link click IS the verification). Asserted by checking the
// form's Props read `email: string` AND there's no editable email
// <input> in the render tree.

const ROOT  = resolve(process.cwd());
const form  = readFileSync(resolve(ROOT, 'app/checkout/[token]/CheckoutForm.tsx'), 'utf8');

describe('CheckoutForm — reuses the shared useFieldValidation hook', () => {
  it('imports useFieldValidation + FieldsSchema + focusAndScrollTo from the same shared module the signup forms use', () => {
    expect(form).toMatch(
      /from\s+['"]@\/lib\/forms\/useFieldValidation['"]/,
    );
    expect(form).toMatch(/useFieldValidation\s*[,}]/);
    expect(form).toMatch(/FieldsSchema/);
    expect(form).toMatch(/focusAndScrollTo/);
  });

  it('calls useFieldValidation with a fields object + schema (matches PatientSignupForm shape)', () => {
    expect(form).toMatch(/useFieldValidation\s*\(\s*details\s*,\s*schema\s*\)/);
  });

  it('imports validators from @/lib/validation rather than reimplementing them inline', () => {
    expect(form).toMatch(/from\s+['"]@\/lib\/validation['"]/);
    expect(form).toMatch(/validateSaId/);
    expect(form).toMatch(/saIdAge/);
    expect(form).toMatch(/normalizePhoneZA/);
  });

  it('uses the SAME single generic SA ID error message as PatientSignupForm', () => {
    expect(form).toMatch(/Please enter a valid SA ID number\./);
    // And does NOT leak the validator's internal reason codes
    // (length/format/date/citizenship/checksum) into user-facing copy.
    expect(form).not.toMatch(/SA ID number must be 13 digits/);
    expect(form).not.toMatch(/citizenship digit/);
    expect(form).not.toMatch(/check digit doesn['']t match/);
  });
});

describe('CheckoutForm — fields wired through the hook', () => {
  it('SA ID input has onBlur + onChange wired to the hook helpers', () => {
    expect(form).toMatch(/id\s*=\s*['"]checkout-saIdNumber['"][\s\S]{0,400}onBlur=\{onBlur\(['"]saIdNumber['"]\)\}/);
    expect(form).toMatch(/id\s*=\s*['"]checkout-saIdNumber['"][\s\S]{0,400}onChange=\{setText\(['"]saIdNumber['"]\)\}/);
  });

  it('phone input has onBlur + onChange wired to the hook helpers', () => {
    expect(form).toMatch(/id\s*=\s*['"]checkout-phone['"][\s\S]{0,400}onBlur=\{onBlur\(['"]phone['"]\)\}/);
    expect(form).toMatch(/id\s*=\s*['"]checkout-phone['"][\s\S]{0,400}onChange=\{setText\(['"]phone['"]\)\}/);
  });

  it('first / last name inputs are wired through the hook', () => {
    expect(form).toMatch(/id\s*=\s*['"]checkout-firstName['"][\s\S]{0,400}onBlur=\{onBlur\(['"]firstName['"]\)\}/);
    expect(form).toMatch(/id\s*=\s*['"]checkout-lastName['"][\s\S]{0,400}onBlur=\{onBlur\(['"]lastName['"]\)\}/);
  });

  it('terms checkbox is in the schema (so a missing tick produces an inline error, not a server bounce)', () => {
    expect(form).toMatch(/termsAccepted/);
    expect(form).toMatch(/onBlur=\{onBlur\(['"]termsAccepted['"]\)\}/);
  });

  it('submit-time backstop calls validateAll() and bounces back to the Details step with the first invalid field focused', () => {
    expect(form).toMatch(/validateAll\(\)/);
    expect(form).toMatch(/focusAndScrollTo\(\s*[`'"]checkout-/);
  });
});

describe('CheckoutForm — processor-neutral copy (no Paystack lingo)', () => {
  it('the footer no longer says "Secured by Paystack"', () => {
    // 2026-07-30: swap left the stale Paystack line in the checkout
    // footer even after the underlying processor became Peach. Pin the
    // replacement copy so a future edit can't regress into the old wording.
    expect(form).not.toMatch(/Secured by Paystack/i);
    expect(form).toMatch(/Secure payments · Card details never touch betternow/);
  });
});

describe('/checkout/[token] initiate — Peach V2 standingInstruction shape', () => {
  const actions = readFileSync(resolve(ROOT, 'app/checkout/[token]/actions.ts'), 'utf8');

  it('sends numberOfInstallments = planType (2 or 3), NOT the previous omit-for-2 pattern', () => {
    // Pre-2026-07-30 the caller omitted numberOfInstallments for
    // planType=2 based on a misread of the Peach docs (confusing
    // Budget Installment acquirer scheme with the V2 standing-
    // instruction schema). The V2 schema accepts 1-999 as INTEGER
    // and REQUIRES numberOfInstallments for INSTALLMENT + INITIAL.
    // Sending planType directly satisfies both.
    expect(actions).toMatch(/numberOfInstallments:\s*planType/);
    // The old omit pattern must be gone.
    expect(actions).not.toMatch(/numberOfInstallments\s*=\s*planType\s*===\s*3\s*\?\s*3\s*:\s*undefined/);
    expect(actions).not.toMatch(/numberOfInstallments\s*!==\s*undefined\s*\?\s*\{\s*numberOfInstallments\s*\}\s*:\s*\{\}/);
  });

  it('sends frequency as an INTEGER (30 = days), NOT the string "0001"', () => {
    // Peach V2 schema: frequency is INTEGER 1-9999, days between
    // recurring authorisations. The old '0001' string was a
    // misidentification as a Mastercard scheme code — Peach's V2
    // validator rejected the whole body with "Invalid request body".
    expect(actions).toMatch(/frequency:\s*30\b/);
    expect(actions).not.toMatch(/frequency:\s*['"]0001['"]/);
  });

  it('does NOT send the OPPWA-only "source" or "initialTransactionId" on V2 (rejected with "unknown field")', () => {
    // 2026-07-30 regression: V2 Checkout does NOT accept source
    // (CIT/MIT) or initialTransactionId — those are recurring API
    // vocabulary. Peach V2 returns {"standingInstruction.source":
    // "unknown field"} and the whole checkout body is rejected.
    // Flow C (chargeSavedCard against /v1/registrations) legitimately
    // uses source — that path is untouched. This pin is V2-only.
    const initiateStart = actions.indexOf('provider.createCheckout');
    expect(initiateStart).toBeGreaterThan(0);
    const initiateEnd = actions.indexOf(');', initiateStart);
    const body = actions.slice(initiateStart, initiateEnd);
    expect(body).not.toMatch(/source:\s*['"]CIT['"]/);
    expect(body).not.toMatch(/initialTransactionId:/);
  });
});

describe('CheckoutForm — email is read-only for the invitation flow, collected only for a POS session (requireEmail)', () => {
  // Post-0085: a POS counter-session token has no known email (unlike
  // an invitation, which resolves it server-side from the token) — the
  // form now collects one, but ONLY when the page passes
  // requireEmail={true} (resolved.kind === 'session'). This was the
  // deliberate future change this describe block's original comment
  // anticipated; the gate below is that deliberate choice made
  // explicit rather than a silent regression.
  it('the email <input> exists but is gated behind requireEmail (not rendered for the invitation flow)', () => {
    expect(form).toMatch(/\{requireEmail\s*&&\s*\(/);
    expect(form).toMatch(/<input[^>]*type\s*=\s*['"]email['"]/);
    expect(form).toMatch(/id\s*=\s*['"]checkout-email['"]/);
  });

  it('email IS a key in the validation schema, but its validator no-ops unless requireEmail', () => {
    expect(form).toMatch(/\bemail\s*:\s*\{\s*validate\s*:/);
    expect(form).toMatch(/if\s*\(!requireEmail\)\s*return\s*null;/);
  });

  it('uses the shared isValidEmail validator, not an inline regex (banned outside lib/validation/)', () => {
    expect(form).toMatch(/import\s*\{[^}]*isValidEmail[^}]*\}\s*from\s*'@\/lib\/validation'/);
    expect(form).toMatch(/isValidEmail\(v\.email\.trim\(\)\)/);
  });
});
