/**
 * Display-only masking for South African ID numbers.
 *
 * Shows the first 6 digits (date of birth) and the last 2 (control + check)
 * with bullets in between. For a standard 13-digit SA ID this yields
 * patterns like `850101•••••23` (6 + 5 bullets + 2).
 *
 * This function NEVER touches stored data or decryption — the input is
 * already a decrypted plain-text ID string. Pass the result straight into
 * UI; do not store it.
 *
 * Defensive: returns `''` for nullish input, returns the input verbatim if
 * it is too short to mask meaningfully (< 9 chars would leave zero bullets).
 */
export function maskSaId(saId: string | null | undefined): string {
  if (saId == null) return '';
  if (saId.length === 0) return '';
  if (saId.length < 9) return saId;

  const head       = saId.slice(0, 6);
  const tail       = saId.slice(-2);
  const middleLen  = saId.length - 8;
  return `${head}${'•'.repeat(middleLen)}${tail}`;
}
