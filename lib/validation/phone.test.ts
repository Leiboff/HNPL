import { describe, it, expect } from 'vitest';
import {
  normalizePhoneZA,
  isValidPhoneZA,
  isNormalizedPhoneZA,
  toNationalDigitsZA,
  formatNationalZA,
  nationalToE164ZA,
  ZA_DIAL_CODE,
  ZA_NATIONAL_DIGITS,
} from './phone';

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

// ─── Entry-time helpers ─────────────────────────────────────────────────
//
// For a field that shows "+27" itself and holds the national part alone —
// the /onboarding phone step. These deliberately validate NOTHING; what
// they produce still goes through normalizePhoneZA at the boundary, and
// the last describe below pins that the two agree.

describe('toNationalDigitsZA', () => {
  it.each([
    ['0821234567',      '821234567', 'the trunk 0 — how South Africans write it'],
    ['821234567',       '821234567', 'already national'],
    ['82 123 4567',     '821234567', 'spaces stripped'],
    ['082-123-4567',    '821234567', 'dashes stripped'],
    ['(082) 123 4567',  '821234567', 'parens stripped'],
    ['+27821234567',    '821234567', 'pasted E.164'],
    ['+27 82 123 4567', '821234567', 'pasted E.164, spaced'],
    ['27821234567',     '821234567', 'no plus'],
    ['0027821234567',   '821234567', 'international 00 prefix'],
    ['+27 082 123 4567','821234567', 'dial code AND trunk 0 — both peeled'],
    ['00821234567',     '821234567', 'doubled trunk 0'],
  ])('%p → %p (%s)', (input, expected) => {
    expect(toNationalDigitsZA(input)).toBe(expected);
  });

  it('caps at the national length, so a runaway paste cannot overflow', () => {
    expect(toNationalDigitsZA('082123456789999')).toBe('821234567');
    expect(toNationalDigitsZA('821234567').length).toBe(ZA_NATIONAL_DIGITS);
  });

  it('passes partial input straight through — a field must allow half a number', () => {
    expect(toNationalDigitsZA('0')).toBe('');
    expect(toNationalDigitsZA('08')).toBe('8');
    expect(toNationalDigitsZA('082')).toBe('82');
    expect(toNationalDigitsZA('0821')).toBe('821');
  });

  it('does NOT mistake a 027 area code for the country code', () => {
    // "27xxxxxxx" is nine digits already — the 027 (Northern Cape) area
    // code, not +27. The length guard is what protects it. It is a
    // landline, so normalizePhoneZA rejects it for a cell field anyway;
    // what matters is that the digits are not silently mangled first.
    expect(toNationalDigitsZA('0271234567')).toBe('271234567');
    expect(toNationalDigitsZA('271234567')).toBe('271234567');
  });

  it('keeps nothing from junk, and tolerates a non-string', () => {
    expect(toNationalDigitsZA('abc')).toBe('');
    expect(toNationalDigitsZA('')).toBe('');
    expect(toNationalDigitsZA(null)).toBe('');
    expect(toNationalDigitsZA(undefined)).toBe('');
  });

  it('is idempotent — re-running it on its own output changes nothing', () => {
    for (const input of ['0821234567', '+27 82 123 4567', '0027821234567', '082']) {
      const once = toNationalDigitsZA(input);
      expect(toNationalDigitsZA(once)).toBe(once);
    }
  });
});

describe('formatNationalZA', () => {
  it.each([
    ['821234567', '82 123 4567'],
    ['8',         '8'],
    ['82',        '82'],
    ['821',       '82 1'],
    ['82123',     '82 123'],
    ['821234',    '82 123 4'],
    ['',          ''],
  ])('%p → %p', (digits, expected) => {
    expect(formatNationalZA(digits)).toBe(expected);
  });

  it('never renders more than the national length', () => {
    expect(formatNationalZA('821234567999')).toBe('82 123 4567');
  });
});

describe('nationalToE164ZA', () => {
  it('prefixes the dial code', () => {
    expect(nationalToE164ZA('821234567')).toBe('+27821234567');
    expect(ZA_DIAL_CODE).toBe('+27');
  });

  it('does not pretend a short number is valid — that is normalizePhoneZA\'s job', () => {
    expect(nationalToE164ZA('82')).toBe('+2782');
    expect(normalizePhoneZA(nationalToE164ZA('82'))).toBeNull();
  });
});

describe('the entry helpers and the gate agree', () => {
  // The round trip the /onboarding phone step actually performs: a person
  // types something, the field reduces it to national digits, and the
  // server re-reads the E.164 form with normalizePhoneZA. Whatever a cell
  // number is typed as, that trip must end at the same stored value.
  it.each([
    '0821234567',
    '082 123 4567',
    '+27821234567',
    '+27 82 123 4567',
    '27821234567',
    '0027821234567',
    '821234567',
  ])('%p survives field → server as +27821234567', (typed) => {
    expect(normalizePhoneZA(nationalToE164ZA(toNationalDigitsZA(typed)))).toBe('+27821234567');
  });

  it('a landline still gets rejected by the gate after passing through the field', () => {
    expect(normalizePhoneZA(nationalToE164ZA(toNationalDigitsZA('0111234567')))).toBeNull();
  });

  it('a formatted display value round-trips back to the same digits', () => {
    const digits = toNationalDigitsZA('0821234567');
    expect(toNationalDigitsZA(formatNationalZA(digits))).toBe(digits);
  });
});
