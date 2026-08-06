/**
 * Display-only masking for South African ID numbers.
 *
 * Reveals ONLY the last 4 digits; everything before is bulleted. The first
 * six digits of an SA ID are the holder's date of birth (YYMMDD), so they
 * must NOT be shown — an earlier version revealed them (`850101•••••23`),
 * leaking DOB. For a standard 13-digit SA ID this now yields `•••••••••0123`
 * (9 bullets + last 4).
 *
 * This function NEVER touches stored data or decryption — the input is
 * already a decrypted plain-text ID string. Pass the result straight into
 * UI; do not store it.
 *
 * Defensive: returns `''` for nullish input, returns the input verbatim if
 * it is too short to mask meaningfully (< 8 chars would reveal almost all
 * of it once four are shown).
 */
export function maskSaId(saId: string | null | undefined): string {
  if (saId == null) return '';
  if (saId.length === 0) return '';
  if (saId.length < 8) return saId;

  const tail      = saId.slice(-4);
  const maskedLen = saId.length - 4;
  return `${'•'.repeat(maskedLen)}${tail}`;
}
