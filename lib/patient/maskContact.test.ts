import { describe, it, expect } from 'vitest';
import { maskEmail, maskPhone } from './maskContact';
import { maskSaId } from '@/lib/saIdMask';

// ─── Contact masking ─────────────────────────────────────────────────────
//
// The point of these two functions is CONSISTENCY with maskSaId, so the
// tests compare against it directly rather than restating its rules — a
// change to the SA ID mask that these diverge from should surface here.

describe('maskPhone', () => {
  it('reveals only the last four characters', () => {
    expect(maskPhone('+27821234567')).toBe('••••••••4567');
  });

  it('uses the SAME shape as maskSaId for a same-length input', () => {
    // The whole reason this file exists: three identifiers on one screen
    // should look masked by the same hand. Compare structurally — bullet
    // count and revealed tail — on inputs of equal length.
    const phone = '+27821234567';
    const id    = '9001015800086';
    expect(maskPhone(phone).length).toBe(phone.length);
    expect(maskSaId(id).length).toBe(id.length);
    const bullets = (s: string) => s.length - s.replace(/•/g, '').length;
    expect(bullets(maskPhone(phone))).toBe(phone.length - 4);
    expect(bullets(maskSaId(id))).toBe(id.length - 4);
  });

  it('returns empty string for nullish, empty, and whitespace input', () => {
    expect(maskPhone(null)).toBe('');
    expect(maskPhone(undefined)).toBe('');
    expect(maskPhone('')).toBe('');
    expect(maskPhone('   ')).toBe('');
  });

  it('returns short input verbatim, exactly as maskSaId does', () => {
    // Under 8 characters, masking all but four would reveal almost all of it,
    // so both helpers decline rather than pretend.
    expect(maskPhone('12345')).toBe('12345');
    expect(maskSaId('12345')).toBe('12345');
  });

  it('never leaks any digit except the last four', () => {
    const masked = maskPhone('+27821234567');
    expect(masked).toContain('4567');
    for (const fragment of ['+27', '2782', '8212', '1234']) {
      expect(masked, fragment).not.toContain(fragment);
    }
  });
});

describe('maskEmail', () => {
  it('keeps the first character and the whole domain', () => {
    expect(maskEmail('dina@artionagency.com')).toBe('d•••@artionagency.com');
  });

  it('does NOT leak the local-part length', () => {
    // The one deliberate divergence from maskSaId, which does leak length
    // (harmlessly — every SA ID is 13 digits). Local parts vary, so two
    // addresses with different local lengths must mask identically.
    expect(maskEmail('ab@x.co.za')).toBe('a•••@x.co.za');
    expect(maskEmail('abcdefghijklmnop@x.co.za')).toBe('a•••@x.co.za');
  });

  it('gives up the first character rather than the privacy on a 1-char local part', () => {
    // Revealing "a" of "a@x.com" reveals the whole local part.
    expect(maskEmail('a@x.co.za')).toBe('•••@x.co.za');
  });

  it('masks completely when there is no domain to preserve', () => {
    // The safer failure: echoing an unparseable value back in full would
    // defeat the point on exactly the malformed input we understand least.
    expect(maskEmail('notanemail')).toBe('•••');
    expect(maskEmail('@leading.com')).toBe('•••');
  });

  it('splits on the LAST @, so an odd address still keeps a real domain', () => {
    expect(maskEmail('weird@thing@example.co.za')).toBe('w•••@example.co.za');
  });

  it('returns empty string for nullish, empty, and whitespace input', () => {
    expect(maskEmail(null)).toBe('');
    expect(maskEmail(undefined)).toBe('');
    expect(maskEmail('')).toBe('');
    expect(maskEmail('  ')).toBe('');
  });

  it('never contains the full original address', () => {
    const email = 'dina@artionagency.com';
    expect(maskEmail(email)).not.toBe(email);
    expect(maskEmail(email)).not.toContain('dina');
  });
});
