import { describe, it, expect } from 'vitest';
import { cardBrandLabel, cardBrandGradient } from './cardBrand';

// ─── Tests — card-brand chip label (single source) ─────────────────────
//
// The bug: the same card rendered "VI" on one surface and "VISA" on
// another because one matched brand case-sensitively and truncated. The
// label must be identical regardless of stored casing.

describe('cardBrandLabel', () => {
  it('is case-insensitive and consistent for Visa', () => {
    expect(cardBrandLabel('Visa')).toBe('VISA');
    expect(cardBrandLabel('VISA')).toBe('VISA');
    expect(cardBrandLabel('visa')).toBe('VISA');
    // The actual bug: these two must agree (previously "VISA" vs "VI").
    expect(cardBrandLabel('VISA')).toBe(cardBrandLabel('Visa'));
  });

  it('maps Mastercard variants to a short chip label', () => {
    expect(cardBrandLabel('Mastercard')).toBe('MC');
    expect(cardBrandLabel('MASTERCARD')).toBe('MC');
    expect(cardBrandLabel('MASTER')).toBe('MC');
  });

  it('maps American Express variants to AMEX', () => {
    expect(cardBrandLabel('Amex')).toBe('AMEX');
    expect(cardBrandLabel('American Express')).toBe('AMEX');
  });

  it('falls back to a trimmed uppercase stub, never empty', () => {
    expect(cardBrandLabel('Diners')).toBe('DINE');
    expect(cardBrandLabel(null)).toBe('CARD');
    expect(cardBrandLabel(undefined)).toBe('CARD');
    expect(cardBrandLabel('')).toBe('CARD');
  });
});

describe('cardBrandGradient', () => {
  it('is case-insensitive (a stored "VISA" gets the Visa gradient, not the default)', () => {
    expect(cardBrandGradient('VISA')).toBe(cardBrandGradient('Visa'));
    expect(cardBrandGradient('VISA')).toContain('#1a1f71');
    expect(cardBrandGradient('MASTERCARD')).toContain('#eb001b');
    expect(cardBrandGradient('Diners')).toContain('#13294B');
  });
});
