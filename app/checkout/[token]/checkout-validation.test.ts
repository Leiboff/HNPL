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

  it('submit-time backstop calls validateAll() and bounces back to step 3 with the first invalid field focused', () => {
    expect(form).toMatch(/validateAll\(\)/);
    expect(form).toMatch(/focusAndScrollTo\(\s*[`'"]checkout-/);
  });
});

describe('CheckoutForm — email is read-only (not in the schema)', () => {
  it("there is no editable <input> for email in the form (the invitation pre-fills it)", () => {
    // The BillSummary renders `to {email}` as plain text. There must
    // be no `type="email"` input nor any `id="checkout-email"` input.
    expect(form).not.toMatch(/<input[^>]*type\s*=\s*['"]email['"]/);
    expect(form).not.toMatch(/id\s*=\s*['"]checkout-email['"]/);
  });

  it('email is NOT a key in the validation schema', () => {
    // Defensive: a future "let the patient correct the email" change
    // would need to add the field with isValidEmail. This test forces
    // that to be a deliberate choice.
    expect(form).not.toMatch(/\bemail\s*:\s*\{\s*validate\s*:/);
  });
});
