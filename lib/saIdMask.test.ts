import { describe, it, expect } from 'vitest';
import { maskSaId } from './saIdMask';

describe('maskSaId', () => {
  it('masks a standard 13-digit SA ID to "first6•••••last2"', () => {
    // The spec example from the design brief.
    expect(maskSaId('8501015800123')).toBe('850101•••••23');
  });

  it('always shows exactly 5 bullets for a 13-character input (6 + 5 + 2 = 13)', () => {
    const masked = maskSaId('1234567890123');
    expect(masked).toHaveLength(13);
    expect(masked.match(/•/g)?.length ?? 0).toBe(5);
  });

  it('preserves the first 6 characters verbatim', () => {
    expect(maskSaId('9912319999987').startsWith('991231')).toBe(true);
  });

  it('preserves the last 2 characters verbatim', () => {
    expect(maskSaId('9912319999987').endsWith('87')).toBe(true);
  });

  it('returns empty string for null / undefined / empty', () => {
    expect(maskSaId(null)).toBe('');
    expect(maskSaId(undefined)).toBe('');
    expect(maskSaId('')).toBe('');
  });

  it('returns the input verbatim if it is too short to mask meaningfully (< 9 chars)', () => {
    expect(maskSaId('12345678')).toBe('12345678');
    expect(maskSaId('1234567')).toBe('1234567');
  });

  it('masks 9-char input with a single bullet (boundary case)', () => {
    // 9 chars: 6 head + 1 middle + 2 tail.
    expect(maskSaId('123456789')).toBe('123456•89');
  });

  it('scales the bullet run with longer inputs (defensive — should not happen for real SA IDs)', () => {
    // 15 chars: 6 head + 7 middle + 2 tail.
    expect(maskSaId('123456789012345')).toBe('123456•••••••45');
  });
});
