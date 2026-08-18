/**
 * Display-only masking for a patient's contact details.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────
 *
 * The account page already masked the SA ID to its last four digits
 * (lib/saIdMask.ts) while showing the email address and phone number in
 * full — the email twice, once in the navy header and once in the field.
 * That is an inconsistent posture rather than a considered one: all three
 * are personal identifiers on a screen a patient may open in a waiting
 * room, and one of them was treated as sensitive.
 *
 * These two functions apply the SAME discipline as `maskSaId`: reveal only
 * the tail needed to recognise the value, bullet everything before it, and
 * never touch stored data. The input is plaintext, the output is for the
 * screen, and neither is ever persisted.
 *
 * ─── MASKED IS NOT READ-ONLY ──────────────────────────────────────────
 *
 * Phone stays fully editable. The masked form is what the field DISPLAYS;
 * tapping Edit reveals the real value to change, because a masked input is
 * unusable. So masking here is a display decision only — no validation, no
 * save path, and no field's behaviour changes.
 */

/**
 * Mask a phone number to its last four characters.
 *
 * Deliberately the same shape as `maskSaId`: bullets for everything but the
 * final four, no spacing or grouping introduced. A grouped form
 * (`••• ••• 4567`) reads slightly better in isolation, but the point of
 * this file is that the three identifiers on one screen look like they were
 * masked by the same hand.
 *
 * Defensive, matching maskSaId exactly: `''` for nullish or empty input,
 * and the input verbatim when it is too short to mask meaningfully (fewer
 * than 8 characters would reveal almost all of it once four are shown).
 */
export function maskPhone(phone: string | null | undefined): string {
  if (phone == null) return '';
  const value = phone.trim();
  if (value.length === 0) return '';
  if (value.length < 8) return value;

  return `${'•'.repeat(value.length - 4)}${value.slice(-4)}`;
}

/**
 * Mask an email address to its first character and its domain.
 *
 * `dina@artionagency.com` → `d•••@artionagency.com`
 *
 * The domain survives because it is what actually lets someone confirm
 * "yes, that is my address" — the local part is the identifying half. The
 * first character is kept for the same reason and no more.
 *
 * ONE DELIBERATE DIVERGENCE FROM maskSaId: the bullet count is FIXED at
 * three rather than tracking the hidden length. maskSaId leaks the ID's
 * length, which is harmless because every SA ID is thirteen digits. Local
 * parts vary, so a length-tracking mask would leak how long the address is
 * — a small thing, but free to avoid.
 *
 * Defensive: `''` for nullish or empty input. An address with no `@` is
 * treated as entirely local and masked completely rather than being echoed
 * back in full — the safer failure. Splitting happens on the LAST `@`,
 * which is where a domain begins even in the odd addresses that contain
 * more than one.
 */
export function maskEmail(email: string | null | undefined): string {
  if (email == null) return '';
  const value = email.trim();
  if (value.length === 0) return '';

  const at = value.lastIndexOf('@');
  if (at <= 0) {
    // No domain to preserve (or a leading '@'), so reveal nothing.
    return '•••';
  }

  const local  = value.slice(0, at);
  const domain = value.slice(at);   // includes the '@'

  // A single-character local part cannot keep a revealed first character
  // AND stay masked, so it gives up the character rather than the privacy.
  if (local.length < 2) return `•••${domain}`;

  return `${local[0]}•••${domain}`;
}
