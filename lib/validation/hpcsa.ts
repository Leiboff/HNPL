// ─── HPCSA registration number — light format validation ───────────────
//
// HPCSA (Health Professions Council of South Africa) practice numbers
// follow a profession-prefix + digits format, e.g. MP1234567 (medical
// practitioner), DP1234567 (dentist), PH1234567 (physiotherapist),
// PS1234567 (psychologist), OT/OP/AU and others. Historical and
// edge-case entries vary; the format is not strictly fixed.
//
// What this validator does (deliberately light):
//   • Strips leading/trailing whitespace.
//   • Accepts an alphanumeric run of 5+ characters (letters can be
//     mixed-case; we don't normalise case here — the grouping layer
//     does that downstream with md5(lower(trim(...)))).
//   • Rejects: empty, all-whitespace, anything shorter than 5 chars,
//     anything with whitespace or special characters in the middle.
//
// What this validator does NOT do:
//   • It does NOT enforce a specific profession prefix — the prefixes
//     drift over time and we don't want a discovery feature to be the
//     authoritative source of truth for HPCSA format.
//   • It does NOT verify the number against the HPCSA register. That
//     is out of scope (and not exposed via API).
//
// Why light is the right call: stricter validation rejects valid
// historical entries; looser allows malformed values that pollute the
// grouping key. The middle path catches obviously broken entries
// (e.g. "asdf", "12", "MP 123 4567", "DP12345 / DP67890") without
// blocking practitioners whose numbers don't fit a tight regex.

const HPCSA_ALNUM_RE = /^[A-Za-z0-9]{5,}$/;

export type HpcsaCheck =
  | { ok: true;  normalised: string }
  | { ok: false; reason: 'empty' | 'too_short' | 'contains_whitespace' | 'contains_special' };

/**
 * Validate an HPCSA practice number. Returns { ok, normalised } on
 * success — `normalised` is the trimmed-and-uppercased form suitable
 * for display. On failure returns a `reason` the caller can map to a
 * user-facing message.
 *
 * The grouping layer at the view level uses
 * `md5(lower(trim(hpcsa_number)))` — independent of this validator.
 * That keeps discovery resilient to historical malformed values: a
 * row whose HPCSA failed validation at capture time still groups
 * deterministically on whatever was stored.
 */
export function checkHpcsa(raw: string | null | undefined): HpcsaCheck {
  if (raw == null) return { ok: false, reason: 'empty' };
  const trimmed = raw.trim();
  if (trimmed.length === 0)    return { ok: false, reason: 'empty' };
  if (trimmed.length < 5)      return { ok: false, reason: 'too_short' };

  // Reject anything with whitespace in the middle ("MP 123 4567").
  if (/\s/.test(trimmed))      return { ok: false, reason: 'contains_whitespace' };

  // Reject special characters / slashes / commas / brackets — the
  // catch-all for the "DP12345 / DP67890" or "MP-1234" style of bad
  // entry that pollutes the grouping key.
  if (!HPCSA_ALNUM_RE.test(trimmed)) {
    return { ok: false, reason: 'contains_special' };
  }

  return { ok: true, normalised: trimmed.toUpperCase() };
}

/** Convenience predicate — same rules as checkHpcsa. */
export function isValidHpcsa(raw: string | null | undefined): boolean {
  return checkHpcsa(raw).ok;
}

/** Human-facing reason strings for form errors. */
export const HPCSA_ERROR_MESSAGE: Record<Exclude<HpcsaCheck, { ok: true }>['reason'], string> = {
  empty:                 'HPCSA number is required.',
  too_short:             'HPCSA number is too short — check what was typed.',
  contains_whitespace:   'HPCSA number cannot contain spaces.',
  contains_special:      'HPCSA number can only contain letters and digits.',
};
