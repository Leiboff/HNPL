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
