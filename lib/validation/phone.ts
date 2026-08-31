/**
 * South African phone number normalisation + validation.
 *
 * Accepts:
 *   "0821234567"         → "+27821234567"
 *   "27821234567"        → "+27821234567"
 *   "+27821234567"       → "+27821234567"
 *   "082 123 4567"       → "+27821234567"  (spaces stripped)
 *   "082-123-4567"       → "+27821234567"  (dashes stripped)
 *   "(082) 123 4567"     → "+27821234567"  (parens stripped)
 *
 * Cells (default — `allowLandline: false`): first digit of the 9-digit
 * national number must be 6, 7 or 8 (Vodacom / MTN / Cell C / Telkom Mobile
 * blocks). Landlines (1-5) accepted only when `allowLandline: true`.
 *
 * Any other leading digit (0 or 9), wrong total length, or unparseable
 * input → returns null. Callers convert null into a user-friendly error
 * at the boundary; storage uses the E.164 form returned here.
 */

export type PhoneNormalizeOptions = {
  /** When true, accept landlines (first digit 1-5). Default false. */
  allowLandline?: boolean;
};

const E164_ZA = /^\+27[1-8][0-9]{8}$/;

export function normalizePhoneZA(
  input: string | null | undefined,
  options: PhoneNormalizeOptions = {},
): string | null {
  if (typeof input !== 'string') return null;
  // Strip whitespace, dashes, parens. Keep digits and a leading +.
  const cleaned = input.replace(/[\s\-()]/g, '');
  if (cleaned.length === 0) return null;

  let local9: string | null = null;
  if (/^\+27[0-9]{9}$/.test(cleaned))      local9 = cleaned.slice(3);
  else if (/^27[0-9]{9}$/.test(cleaned))   local9 = cleaned.slice(2);
  else if (/^0[0-9]{9}$/.test(cleaned))    local9 = cleaned.slice(1);
  else return null;

  const first = local9[0];
  const isMobile   = first === '6' || first === '7' || first === '8';
  const isLandline = first >= '1' && first <= '5';

  if (isMobile) return `+27${local9}`;
  if (isLandline && options.allowLandline) return `+27${local9}`;
  return null;
}

export function isValidPhoneZA(
  input: string | null | undefined,
  options: PhoneNormalizeOptions = {},
): boolean {
  return normalizePhoneZA(input, options) !== null;
}

/** True if `input` is already in canonical +27XXXXXXXXX form. */
export function isNormalizedPhoneZA(input: string): boolean {
  return E164_ZA.test(input);
}

// ─── Entry-time helpers, for a field that shows the dial code itself ────
//
// normalizePhoneZA above is the GATE: it decides whether a string is a
// usable SA number and returns the canonical form to store. These three
// are for the other end of the same problem — a field that already
// displays "+27" beside itself and therefore wants the NATIONAL part
// alone, formatted as a person reads it.
//
// They live here rather than in the component because they encode the
// same country's dialling rules, and a copy in a component is how those
// rules drift (see lib/validation/regression.test.ts, which bans exactly
// that). They deliberately VALIDATE NOTHING: a field must let someone
// type a half-finished number without being told it is wrong. What they
// return still goes through normalizePhoneZA at the boundary.

/** Digits in the national part of an SA number, e.g. 82 123 4567. */
export const ZA_NATIONAL_DIGITS = 9;

/** The dial code a +27 field displays beside its input. */
export const ZA_DIAL_CODE = '+27';

/**
 * Reduce anything a person can type or paste to the national digits.
 *
 *   "0821234567"      → "821234567"   (trunk 0 dropped)
 *   "82 123 4567"     → "821234567"
 *   "+27 82 123 4567" → "821234567"
 *   "27821234567"     → "821234567"
 *   "0027821234567"   → "821234567"
 *
 * The trunk 0 is the point of it. South Africans write their number as
 * 082…, and 0 is a national trunk prefix that is NOT part of the number —
 * "+27 082…" is not a phone number anywhere. Dropping it silently as
 * they type is better than accepting it and erroring on submit.
 *
 * Prefixes are peeled in a loop rather than in a fixed order because they
 * arrive in combinations ("0027…", "+27 082…") and a single pass would
 * leave one of them behind.
 *
 * A national number never begins with 0 (mobile blocks start 6/7/8,
 * landline area codes 1-5), so stripping leading zeros can never eat a
 * real digit. The 27 strip is length-guarded so a 027x area code — nine
 * digits already, and a landline this helper's callers reject anyway —
 * is not mistaken for a country code.
 */
export function toNationalDigitsZA(input: string | null | undefined): string {
  if (typeof input !== 'string') return '';
  let digits = input.replace(/\D/g, '');
  let previous = '';
  while (digits !== previous) {
    previous = digits;
    if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
    if (digits.length > ZA_NATIONAL_DIGITS && digits.startsWith('27')) digits = digits.slice(2);
  }
  return digits.slice(0, ZA_NATIONAL_DIGITS);
}

/**
 * Group national digits the way South Africans read them: "82 123 4567".
 * Partial input groups as far as it goes ("821" → "82 1"), so the spacing
 * appears while typing rather than jumping in at the end.
 */
export function formatNationalZA(nationalDigits: string): string {
  const d = nationalDigits.slice(0, ZA_NATIONAL_DIGITS);
  return [d.slice(0, 2), d.slice(2, 5), d.slice(5, 9)].filter(Boolean).join(' ');
}

/**
 * National digits → the E.164 candidate to submit. Named rather than
 * concatenated at the call site so no component decides for itself what
 * the country code is. Still a CANDIDATE: normalizePhoneZA is what says
 * whether it is a real number, and it rejects a short one.
 */
export function nationalToE164ZA(nationalDigits: string): string {
  return `${ZA_DIAL_CODE}${nationalDigits}`;
}
