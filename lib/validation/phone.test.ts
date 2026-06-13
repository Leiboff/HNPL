import { describe, it, expect } from 'vitest';
import { normalizePhoneZA, isValidPhoneZA, isNormalizedPhoneZA } from './phone';

describe('normalizePhoneZA — mobile (default)', () => {
  it.each([
    ['0821234567',        '+27821234567'],
    ['0721234567',        '+27721234567'],
    ['0621234567',        '+27621234567'],
    ['27821234567',       '+27821234567'],
    ['+27821234567',      '+27821234567'],
    ['082 123 4567',      '+27821234567'],
    ['082-123-4567',      '+27821234567'],
    ['(082) 123 4567',    '+27821234567'],
    ['+27 82 123 4567',   '+27821234567'],
    ['  +27821234567  ',  '+27821234567'],
  ])('normalises %s → %s', (input, expected) => {
    expect(normalizePhoneZA(input)).toBe(expected);
  });

  it.each([
    ['0111234567', 'landline rejected without opt-in'],
    ['0911234567', 'leading 9 always rejected'],
    ['0011234567', 'leading 0 in national portion rejected'],
    ['08212345',   'too short'],
    ['082123456789', 'too long'],
    ['',           'empty'],
    ['abc',        'non-numeric'],
    ['+44821234567', 'wrong country code'],
  ])('rejects %p (%s)', (input) => {
    expect(normalizePhoneZA(input)).toBeNull();
  });

  it.each([null, undefined, 123, {}])('rejects non-string %p', (input) => {
    expect(normalizePhoneZA(input as unknown as string)).toBeNull();
  });
});

describe('normalizePhoneZA — landlines (allowLandline=true)', () => {
  it.each([
    ['0111234567',  '+27111234567'],   // Jhb landline
    ['0211234567',  '+27211234567'],   // Cape Town
    ['0311234567',  '+27311234567'],   // KZN
    ['(011) 123 4567', '+27111234567'],
  ])('accepts %s → %s', (input, expected) => {
    expect(normalizePhoneZA(input, { allowLandline: true })).toBe(expected);
  });

  it('still rejects leading 0 and 9 with allowLandline', () => {
    expect(normalizePhoneZA('0011234567', { allowLandline: true })).toBeNull();
    expect(normalizePhoneZA('0911234567', { allowLandline: true })).toBeNull();
  });

  it('still accepts mobile numbers with allowLandline (mobile is always OK)', () => {
    expect(normalizePhoneZA('0821234567', { allowLandline: true })).toBe('+27821234567');
  });
});

describe('isValidPhoneZA', () => {
  it('mirrors normalizePhoneZA(...) !== null', () => {
    expect(isValidPhoneZA('0821234567')).toBe(true);
    expect(isValidPhoneZA('0111234567')).toBe(false);
    expect(isValidPhoneZA('0111234567', { allowLandline: true })).toBe(true);
    expect(isValidPhoneZA('')).toBe(false);
  });
});

describe('isNormalizedPhoneZA', () => {
  it('returns true only for the canonical +27XXXXXXXXX form', () => {
    expect(isNormalizedPhoneZA('+27821234567')).toBe(true);
    expect(isNormalizedPhoneZA('0821234567')).toBe(false);
    expect(isNormalizedPhoneZA('27821234567')).toBe(false);
    expect(isNormalizedPhoneZA('+27 82 123 4567')).toBe(false);
  });
});
