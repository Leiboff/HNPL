import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Signup forms — shared-hook + required-set regression ────────────────────
//
// Two assertions per form:
//   • The form file imports the shared validation-timing hook
//     (`useFieldValidation`) — proves we didn't hand-roll per-field touched
//     logic in either form.
//   • The required-field set is exactly the set we expect, asserted via
//     the server `validate()` strings. The server is authoritative; if a
//     client regression silently drops a required check we still catch it
//     here as long as the SAME field stays required server-side.

const ROOT = resolve(process.cwd());

function readSrc(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

// ─── Shared-hook adoption ────────────────────────────────────────────────────

describe('signup forms use the shared useFieldValidation hook', () => {
  it('practice form imports useFieldValidation from @/lib/forms/useFieldValidation', () => {
    const src = readSrc('app/signup/practice/page.tsx');
    expect(src).toMatch(/from\s+['"]@\/lib\/forms\/useFieldValidation['"]/);
    expect(src).toMatch(/\buseFieldValidation\b/);
  });

  it('patient form imports useFieldValidation from @/lib/forms/useFieldValidation', () => {
    const src = readSrc('app/signup/patient/PatientSignupForm.tsx');
    expect(src).toMatch(/from\s+['"]@\/lib\/forms\/useFieldValidation['"]/);
    expect(src).toMatch(/\buseFieldValidation\b/);
  });
});

// ─── Required-set on the practice server action ──────────────────────────────

describe('practice signup — server required-field set', () => {
  const src = readSrc('app/signup/practice/actions.ts');

  it.each([
    ['Practice name', 'Practice name is required.'],
    ['Specialty',     'Specialty is required.'],
    ['Street',        'Street address is required.'],
    ['Suburb',        'Suburb is required.'],
    ['City',          'City is required.'],
    ['Province',      'Province is required.'],
    ['Postal code',   'Postal code is required.'],
    ['First name',    'First name is required.'],
    ['Last name',     'Last name is required.'],
  ])('rejects missing %s', (_name, message) => {
    expect(src).toContain(message);
  });

  it('does NOT require Practice number (PR)', () => {
    // No "Practice number is required" / "PR is required" string — PR is optional.
    expect(src).not.toMatch(/Practice number.*required/i);
    expect(src).not.toMatch(/\bPR\b.*required/);
  });

  it('does NOT require Address line 2', () => {
    expect(src).not.toMatch(/Address line 2.*required/i);
  });
});

// ─── No '(optional)' label text anywhere on the signup forms ─────────────────
//
// The asterisk-on-required convention means optional fields carry no marker
// at all. The previous "(optional)" parenthetical is gone; future copy-paste
// would re-introduce it. Lock it out via source text.

describe('signup forms — no "(optional)" label text', () => {
  it('practice form does not contain "(optional)"', () => {
    const src = readSrc('app/signup/practice/page.tsx');
    expect(src).not.toContain('(optional)');
  });

  it('patient form does not contain "(optional)"', () => {
    const src = readSrc('app/signup/patient/PatientSignupForm.tsx');
    expect(src).not.toContain('(optional)');
  });
});

// ─── Branded "betternow terms" link present on both forms ────────────────────

describe('signup forms — branded betternow terms link', () => {
  it('practice form links /legal/terms with lowercase "betternow"', () => {
    const src = readSrc('app/signup/practice/page.tsx');
    expect(src).toContain('/legal/terms');
    expect(src).toContain('betternow');
  });

  it('patient form links /legal/terms with lowercase "betternow"', () => {
    const src = readSrc('app/signup/patient/PatientSignupForm.tsx');
    expect(src).toContain('/legal/terms');
    expect(src).toContain('betternow');
  });
});
