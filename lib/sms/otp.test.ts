import { describe, it, expect, beforeEach } from 'vitest';
import { generateOtpCode, hashOtpCode } from './otp';

// ─── OTP utility contract ────────────────────────────────────────────────
//
// generateOtpCode + hashOtpCode are pure, so they're cheap to test
// runtime — and worth doing properly because they're the load-bearing
// crypto for the phone gate.

describe('generateOtpCode', () => {
  it('always returns a 6-digit numeric string', () => {
    for (let i = 0; i < 256; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(code.length).toBe(6);
    }
  });

  it('includes codes starting with zeros (no left-strip bias)', () => {
    // A naive `Math.random().toString().slice(...)` would underweight
    // codes starting with 0 because it drops leading zeros. With
    // crypto.randomInt + padStart we get a uniform draw. Across enough
    // samples we expect ~10% to start with '0'.
    let zeros = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      if (generateOtpCode().startsWith('0')) zeros++;
    }
    // 4000 trials, p ~ 0.1 ⇒ expect ~400, sd ~ 19. Allow a wide
    // window so flakes are essentially impossible.
    expect(zeros).toBeGreaterThan(280);
    expect(zeros).toBeLessThan(520);
  });

  it('does not repeat — high entropy from crypto.randomInt', () => {
    // A 6-digit code has a million possible values; a small sample
    // should have zero collisions with overwhelming probability.
    const seen = new Set<string>();
    for (let i = 0; i < 256; i++) seen.add(generateOtpCode());
    expect(seen.size).toBeGreaterThan(254);
  });
});

describe('hashOtpCode', () => {
  beforeEach(() => {
    process.env.PHONE_OTP_PEPPER = 'test-pepper-with-enough-entropy-for-vitest-cases';
  });

  it('throws if PHONE_OTP_PEPPER is missing (loud failure, not silent crackable hashes)', () => {
    delete process.env.PHONE_OTP_PEPPER;
    expect(() => hashOtpCode('123456')).toThrow(/PHONE_OTP_PEPPER/);
  });

  it('produces a 64-char hex SHA-256 digest', () => {
    expect(hashOtpCode('123456')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for the same (code, pepper) pair', () => {
    expect(hashOtpCode('482165')).toBe(hashOtpCode('482165'));
  });

  it('different codes hash to different digests', () => {
    expect(hashOtpCode('111111')).not.toBe(hashOtpCode('111112'));
  });

  it('different peppers hash the same code to different digests', () => {
    const a = hashOtpCode('482165');
    process.env.PHONE_OTP_PEPPER = 'different-pepper-value';
    const b = hashOtpCode('482165');
    expect(a).not.toBe(b);
  });
});
