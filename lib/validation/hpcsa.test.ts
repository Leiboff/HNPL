import { describe, it, expect } from 'vitest';
import { checkHpcsa, isValidHpcsa, HPCSA_ERROR_MESSAGE } from './hpcsa';

// ─── Tests — HPCSA light format validation ─────────────────────────────
//
// Pins the validator's contract: it stops obviously-broken entries
// from being captured (which would pollute the grouping key in the
// discovery view) while accepting the format variation HPCSA itself
// allows in practice. We do NOT enforce a specific profession prefix
// — that would reject valid historical entries.

describe('checkHpcsa', () => {
  it('accepts a normal MP-prefixed number', () => {
    expect(checkHpcsa('MP1234567')).toEqual({ ok: true, normalised: 'MP1234567' });
  });

  it('accepts DP / PH / PS / other prefixes (no enforced prefix list)', () => {
    expect(checkHpcsa('DP9876543').ok).toBe(true);
    expect(checkHpcsa('PH1112223').ok).toBe(true);
    expect(checkHpcsa('PS4445556').ok).toBe(true);
    expect(checkHpcsa('OT0001234').ok).toBe(true);
  });

  it('trims surrounding whitespace and uppercases', () => {
    const r = checkHpcsa('  mp1234567  ');
    expect(r).toEqual({ ok: true, normalised: 'MP1234567' });
  });

  it('accepts a pure-digit historical entry (no prefix)', () => {
    // Some legacy practitioners are recorded as digits only — the
    // validator must NOT reject them just because there's no prefix.
    expect(checkHpcsa('1234567').ok).toBe(true);
  });

  it('rejects empty / whitespace-only', () => {
    expect(checkHpcsa('')).toEqual({ ok: false, reason: 'empty' });
    expect(checkHpcsa('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(checkHpcsa(null)).toEqual({ ok: false, reason: 'empty' });
    expect(checkHpcsa(undefined)).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects too-short strings (< 5 chars after trim)', () => {
    expect(checkHpcsa('MP12')).toEqual({ ok: false, reason: 'too_short' });
    expect(checkHpcsa('1234')).toEqual({ ok: false, reason: 'too_short' });
  });

  it('rejects entries with internal whitespace', () => {
    expect(checkHpcsa('MP 123 4567')).toEqual({ ok: false, reason: 'contains_whitespace' });
    expect(checkHpcsa('MP 1234567')).toEqual({ ok: false, reason: 'contains_whitespace' });
  });

  it('rejects entries with special characters (slash, dash, comma, dot)', () => {
    for (const v of ['MP12345/67', 'MP-1234567', 'MP12345,67', 'MP12345.67']) {
      const r = checkHpcsa(v);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe('contains_special');
    }
  });

  it('rejects two HPCSA numbers entered as one ("DP12345 / DP67890")', () => {
    // This is exactly the "polluted grouping key" pattern the
    // capture-time validation is for: the human typed both their
    // numbers into a single field. Better to reject and let them
    // re-enter as one.
    expect(checkHpcsa('DP12345 / DP67890').ok).toBe(false);
  });
});

describe('isValidHpcsa convenience', () => {
  it('mirrors checkHpcsa.ok', () => {
    expect(isValidHpcsa('MP1234567')).toBe(true);
    expect(isValidHpcsa('MP-1234567')).toBe(false);
    expect(isValidHpcsa(null)).toBe(false);
  });
});

describe('HPCSA_ERROR_MESSAGE — human-facing copy', () => {
  it('has a message for each failure reason', () => {
    for (const reason of ['empty', 'too_short', 'contains_whitespace', 'contains_special'] as const) {
      expect(HPCSA_ERROR_MESSAGE[reason]).toBeTruthy();
    }
  });
});
