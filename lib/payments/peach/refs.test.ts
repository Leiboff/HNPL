import { describe, it, expect } from 'vitest';
import {
  mintPeachRef,
  peachRefPurpose,
  checkoutRef,
  instalmentAttemptRef,
  settleRef,
  registrationRef,
} from './refs';

// ─── Compact Peach merchantTransactionId — invariants ──────────────
//
// Peach V2 hard limit: 16 chars (Visa/Mastercard 3DS2 mandate; violation
// returns result code 800.100.156). Every ref produced by refs.ts MUST
// satisfy that at ALL times — the tests below pin it under multiple
// axes (per-purpose, per-seed, burst uniqueness).

describe('mintPeachRef — length invariant', () => {
  it('produces EXACTLY 16-character refs for every purpose', () => {
    for (const purpose of ['c', 'i', 's', 'r'] as const) {
      const ref = mintPeachRef(purpose, `seed-${purpose}`);
      expect(ref.length).toBe(16);
    }
  });

  it('produces 16 chars regardless of seed length', () => {
    for (const seed of ['x', 'a-medium-seed', 'a-very-long-seed-that-would-blow-any-fixed-budget-1234567890'.repeat(5)]) {
      const ref = mintPeachRef('c', seed);
      expect(ref.length).toBe(16);
    }
  });

  it('starts with `bn<purpose>` and uses only [a-z0-9] in the body', () => {
    const ref = mintPeachRef('c', 'seed');
    expect(ref.startsWith('bnc')).toBe(true);
    expect(ref.slice(3)).toMatch(/^[a-z0-9]{13}$/);
  });

  it('refuses an empty seed', () => {
    expect(() => mintPeachRef('c', '')).toThrow(/seed is required/);
  });
});

describe('mintPeachRef — determinism', () => {
  it('same (purpose, seed) → same ref (Peach dedups on identical mtxid)', () => {
    const a = mintPeachRef('i', 'payment-123.attempt-1');
    const b = mintPeachRef('i', 'payment-123.attempt-1');
    expect(a).toBe(b);
  });

  it('different seeds → different refs', () => {
    const a = mintPeachRef('i', 'payment-123.attempt-1');
    const b = mintPeachRef('i', 'payment-123.attempt-2');
    expect(a).not.toBe(b);
  });

  it('different purposes over the same seed → different refs', () => {
    const c = mintPeachRef('c', 'seed');
    const r = mintPeachRef('r', 'seed');
    expect(c).not.toBe(r);
  });
});

describe('mintPeachRef — uniqueness under burst', () => {
  it('generates 10000 distinct refs from distinct seeds with no collisions', () => {
    const set = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      set.add(mintPeachRef('c', `burst-seed-${i}`));
    }
    expect(set.size).toBe(10_000);
  });
});

describe('peachRefPurpose — round-trip classifier', () => {
  it('recovers the purpose from a well-formed ref', () => {
    expect(peachRefPurpose(mintPeachRef('c', 'x'))).toBe('c');
    expect(peachRefPurpose(mintPeachRef('i', 'x'))).toBe('i');
    expect(peachRefPurpose(mintPeachRef('s', 'x'))).toBe('s');
    expect(peachRefPurpose(mintPeachRef('r', 'x'))).toBe('r');
  });

  it('returns null on refs that do not match our shape', () => {
    expect(peachRefPurpose(null)).toBeNull();
    expect(peachRefPurpose(undefined)).toBeNull();
    expect(peachRefPurpose('')).toBeNull();
    expect(peachRefPurpose('hnpl_reg_' + 'x'.repeat(20))).toBeNull();   // historic long ref
    expect(peachRefPurpose('bnc1234567890')).toBeNull();                // too short (13 chars)
    expect(peachRefPurpose('BNCabc1234567890')).toBeNull();             // wrong-case prefix
    expect(peachRefPurpose('bnx1234567890abc')).toBeNull();             // unknown purpose char
  });
});

// ─── Seed-builder wrappers ─────────────────────────────────────────

describe('checkoutRef / instalmentAttemptRef / settleRef / registrationRef', () => {
  it('checkoutRef is 16 chars + purpose="c"', () => {
    const r = checkoutRef('payment-uuid-abc');
    expect(r.length).toBe(16);
    expect(peachRefPurpose(r)).toBe('c');
  });

  it('checkoutRef is deterministic per payment id', () => {
    expect(checkoutRef('payment-uuid-abc')).toBe(checkoutRef('payment-uuid-abc'));
  });

  it('instalmentAttemptRef is 16 chars + purpose="i" + attempt-differentiated', () => {
    const a1 = instalmentAttemptRef('payment-uuid-abc', 1);
    const a2 = instalmentAttemptRef('payment-uuid-abc', 2);
    expect(a1.length).toBe(16);
    expect(peachRefPurpose(a1)).toBe('i');
    expect(a1).not.toBe(a2);
    // Idempotent per attempt.
    expect(instalmentAttemptRef('payment-uuid-abc', 1)).toBe(a1);
  });

  it('settleRef is 16 chars + purpose="s"', () => {
    const r = settleRef('settlement-uuid-1');
    expect(r.length).toBe(16);
    expect(peachRefPurpose(r)).toBe('s');
  });

  it('registrationRef is 16 chars + purpose="r"', () => {
    const r = registrationRef('some-nonce-uuid');
    expect(r.length).toBe(16);
    expect(peachRefPurpose(r)).toBe('r');
  });

  it('all four seed-builders live within the Peach 16-char limit', () => {
    const refs = [
      checkoutRef('a'),
      instalmentAttemptRef('a', 1),
      settleRef('a'),
      registrationRef('a'),
    ];
    for (const r of refs) expect(r.length).toBeLessThanOrEqual(16);
  });
});
