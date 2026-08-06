import { describe, it, expect } from 'vitest';
import { maskSaId } from './saIdMask';

describe('maskSaId', () => {
  it('masks a standard 13-digit SA ID revealing ONLY the last 4', () => {
    // The first six digits are the holder's date of birth (YYMMDD) and must
    // never be shown. 13 chars → 9 bullets + last 4.
    expect(maskSaId('8501015800123')).toBe('•••••••••0123');
  });

  it('never leaks the date of birth (first 6 digits)', () => {
    const masked = maskSaId('8501015800123');
    expect(masked).not.toContain('850101');
    expect(masked.startsWith('•')).toBe(true);
  });

  it('shows exactly the last 4 characters verbatim', () => {
    const masked = maskSaId('9912319999987');
    expect(masked.endsWith('9987')).toBe(true);
    expect(masked).toHaveLength(13);
    expect(masked.match(/•/g)?.length ?? 0).toBe(9);
  });

  it('returns empty string for null / undefined / empty', () => {
    expect(maskSaId(null)).toBe('');
    expect(maskSaId(undefined)).toBe('');
    expect(maskSaId('')).toBe('');
  });

  it('returns the input verbatim if it is too short to mask meaningfully (< 8 chars)', () => {
    expect(maskSaId('1234567')).toBe('1234567');
  });

  it('masks an 8-char input to 4 bullets + last 4 (boundary case)', () => {
    expect(maskSaId('12345678')).toBe('••••5678');
  });

  it('scales the bullet run with longer inputs (defensive — should not happen for real SA IDs)', () => {
    // 15 chars: 11 bullets + last 4.
    expect(maskSaId('123456789012345')).toBe('•••••••••••2345');
  });
});
