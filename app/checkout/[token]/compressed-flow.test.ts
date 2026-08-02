import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Cold-checkout compressed to ~3 taps — source-text pins ─────────
//
// Target flow: link → [split choice: pay-in-3 default, stacked] →
// [details + T&C] → tap pay (button spinner, NO interstitial page) →
// card widget → success.
//
// Two screens were dead weight and are removed:
//   FIX 3 — the opening "You have a bill to settle" restatement screen
//           (pure restatement: no consent, no data capture) — the link
//           now lands directly on the split-choice screen.
//   FIX 1 — the standalone "Setting up your payment…" interstitial —
//           replaced by a button-level "Setting up…" spinner on the
//           step the patient is already on.
// FIX 2 (plan order + stacked + default) is pinned in
// _components/PlanPickerCards.test.tsx; here we pin the default only.

const ROOT = resolve(process.cwd());
const FORM = readFileSync(resolve(ROOT, 'app/checkout/[token]/CheckoutForm.tsx'), 'utf8');

// ─── FIX 3 — link lands on split-choice; no opening restatement ────

describe('FIX 3 — no opening "bill restatement" screen; link lands on split-choice', () => {
  it('the flow is exactly three steps', () => {
    expect(FORM).toMatch(/type Step = 1 \| 2 \| 3\b/);
  });

  it('the initial step is 1 and step 1 IS the split-choice screen', () => {
    expect(FORM).toMatch(/useState<Step>\(1\)/);
    expect(FORM).toMatch(/step === 1 &&[\s\S]{0,400}heading="Choose how to split your bill"/);
  });

  it('the removed screen and its "Review my plan" tap are gone', () => {
    expect(FORM).not.toContain('You have a bill to settle');
    expect(FORM).not.toContain('Review my plan');
  });

  it('the split-choice screen is the landing screen — it has no "← Back"', () => {
    // Isolate step 1's block (up to the step 2 marker) and assert no Back.
    const s1 = FORM.slice(
      FORM.indexOf('step === 1 &&'),
      FORM.indexOf('Step 2: details'),
    );
    expect(s1).not.toContain('← Back');
  });
});

// ─── FIX 1 — no standalone "Setting up your payment" page/state ────

describe('FIX 1 — hand-off is a button spinner, not a standalone screen', () => {
  it('there is NO "Setting up your payment" screen heading and no step 5', () => {
    expect(FORM).not.toContain('Setting up your payment');
    expect(FORM).not.toMatch(/step === 5/);
    expect(FORM).not.toMatch(/setStep\(5\)/);
  });

  it('OTP verify triggers the hand-off inline (flag, not a page nav)', () => {
    expect(FORM).toMatch(/onVerified=\{handleVerified\}/);
    expect(FORM).toMatch(/function handleVerified\(\)\s*\{[\s\S]{0,120}setHandoff\(true\)[\s\S]{0,40}submitPay\(\)/);
  });

  it('the hand-off renders a button-level "Setting up…" spinner in place (step 3, handoff)', () => {
    expect(FORM).toMatch(/step === 3 && handoff/);
    expect(FORM).toMatch(/data-testid="checkout-handoff-loading"/);
    expect(FORM).toContain('Setting up…');
    // The reassurance ("no money taken") copy is preserved.
    expect(FORM).toContain('No charge yet');
  });

  it('still redirects to the single confirm→widget surface, unchanged', () => {
    expect(FORM).toMatch(/router\.replace\(`\/checkout\/\$\{token\}`\)/);
    expect(FORM).not.toMatch(/<PeachWidget/);
  });
});

// ─── FIX 2 (default) + KEEP (details/T&C intact) ───────────────────

describe('plan default + details step intact', () => {
  it('the 3-payment (smaller instalment) option is the pre-selected default', () => {
    expect(FORM).toMatch(/useState<2 \| 3>\(3\)/);
  });

  it('the details step keeps ID, cellphone, and the T&C consent checkbox', () => {
    expect(FORM).toMatch(/step === 2 &&[\s\S]{0,120}heading="Just your details"/);
    expect(FORM).toContain('id="checkout-saIdNumber"');
    expect(FORM).toContain('id="checkout-phone"');
    expect(FORM).toContain('id="checkout-termsAccepted"');
  });
});
