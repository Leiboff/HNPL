import { describe, it, expect } from 'vitest';
import { generateTempPassword } from './tempPassword';

// ─── Temp-password policy-safety regression ───────────────────────────────
//
// Reason this test exists: a "weak_password" error mid-checkout was
// being thrown by Supabase's admin auth API because the temp password
// (which the patient never sees, only the auth flow uses) was failing
// the project's password policy. A naive `randomBytes(24).toString
// ('base64url')` produces 32 chars from [A-Za-z0-9_-]; ~36% of those
// outputs contain no symbol, ~0.5% contain no digit, etc.
//
// These tests pin the four properties of the temp password that
// closing the bug depended on. Pseudo-random output makes this
// inherently a probabilistic test, but the *guarantee* is now a fixed
// prefix — so a single sample is sufficient to prove the property,
// and a large batch is sufficient to catch any future tweak that
// regresses the guarantee.

const BATCH = 200;

function classes(s: string) {
  return {
    lower:  /[a-z]/.test(s),
    upper:  /[A-Z]/.test(s),
    digit:  /[0-9]/.test(s),
    // Supabase's "symbol" alphabet for the strictest preset:
    //   !@#$%^&*()_+-=[]{};':"\|,.<>/?~`
    // We test against any ASCII non-alphanumeric, which is a SUPERSET.
    symbol: /[^A-Za-z0-9]/.test(s),
  };
}

describe('generateTempPassword — satisfies any Supabase password policy', () => {
  it('a single sample contains lowercase, uppercase, digit AND symbol', () => {
    const pwd = generateTempPassword();
    const c = classes(pwd);
    expect(c.lower).toBe(true);
    expect(c.upper).toBe(true);
    expect(c.digit).toBe(true);
    expect(c.symbol).toBe(true);
  });

  it(`a batch of ${BATCH} samples all satisfy the four-class requirement`, () => {
    // The fix is a fixed prefix, so this is deterministic — but the
    // batch flushes any future regression where someone "improves"
    // the helper into a pure randomBytes() call (which fails this
    // ~36% of the time).
    for (let i = 0; i < BATCH; i++) {
      const pwd = generateTempPassword();
      const c   = classes(pwd);
      expect(c.lower,  `lowercase missing: ${pwd}`).toBe(true);
      expect(c.upper,  `uppercase missing: ${pwd}`).toBe(true);
      expect(c.digit,  `digit missing: ${pwd}`).toBe(true);
      expect(c.symbol, `symbol missing: ${pwd}`).toBe(true);
    }
  });

  it('comfortably exceeds the 8-char minimum length most policies enforce', () => {
    const pwd = generateTempPassword();
    expect(pwd.length).toBeGreaterThanOrEqual(16);
  });

  it('output is sufficiently unique across calls (entropy is real)', () => {
    // Sanity check: the random suffix actually changes. Catches a
    // hypothetical regression to a constant temp password (which
    // would also break sign-in, but better to fail here loudly).
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) seen.add(generateTempPassword());
    expect(seen.size).toBe(64);
  });
});
