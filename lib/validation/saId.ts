/**
 * South African ID number validation.
 *
 * Structure (13 digits, positions 1–13 left-to-right):
 *   YY MM DD  : Date of birth (positions 1–6).
 *   SSSS      : Sequence (positions 7–10). Encodes gender: 0000–4999 female,
 *               5000–9999 male. We don't validate the sequence beyond range.
 *   C         : Citizenship status (position 11). Allowed values: 0, 1, 2.
 *   A         : Race indicator (position 12). Historically used; ignored
 *               here — any digit accepted.
 *   Z         : Luhn check digit (position 13).
 *
 * Century pivot rule (documented as required by the brief):
 *   Try 20YY first. If 20YY > today, fall back to 19YY. Reject ages above 115.
 *   For YYs where both centuries yield a plausible age (e.g. YY=12 in 2026
 *   could be a 14-year-old or a 114-year-old), the more recent century is
 *   chosen — the 114-year-old population is small enough not to optimise
 *   for, and patient onboarding has a hard 18+ gate elsewhere.
 *
 * Luhn algorithm (the spec the brief described):
 *   Iterate digits right-to-left, doubling every other digit starting from
 *   the digit immediately left of the check digit. If a doubled value > 9,
 *   sum its digits (equivalently, subtract 9). Add all values together with
 *   the check digit; the total mod 10 must be 0.
 */

export type SaIdInvalidReason = 'length' | 'format' | 'date' | 'citizenship' | 'checksum';

export type SaIdValidation =
  | { valid: true }
  | { valid: false; reason: SaIdInvalidReason };

const MAX_AGE_YEARS = 115;

export function validateSaId(id: string | null | undefined): SaIdValidation {
  if (typeof id !== 'string' || id.length === 0) return { valid: false, reason: 'length' };
  if (id.length !== 13)                           return { valid: false, reason: 'length' };
  if (!/^\d{13}$/.test(id))                       return { valid: false, reason: 'format' };

  if (parseSaIdDate(id) === null) return { valid: false, reason: 'date' };

  const citizenship = id[10];
  if (citizenship !== '0' && citizenship !== '1' && citizenship !== '2') {
    return { valid: false, reason: 'citizenship' };
  }

  if (!luhnValid(id)) return { valid: false, reason: 'checksum' };

  return { valid: true };
}

/** Date of birth encoded in positions 1–6, or null if unparseable. */
export function saIdDateOfBirth(id: string, now: Date = new Date()): Date | null {
  if (typeof id !== 'string' || !/^\d{13}$/.test(id)) return null;
  return parseSaIdDate(id, now);
}

/**
 * Completed-years age at `at` (defaults to today). Returns null if the ID's
 * date can't be parsed. Caller is responsible for the 18+ comparison.
 */
export function saIdAge(id: string, at: Date = new Date()): number | null {
  const dob = saIdDateOfBirth(id, at);
  if (!dob) return null;
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const m = at.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

// ─── Internals ───────────────────────────────────────────────────────────────

function parseSaIdDate(id: string, now: Date = new Date()): Date | null {
  const yy = Number(id.slice(0, 2));
  const mm = Number(id.slice(2, 4));
  const dd = Number(id.slice(4, 6));

  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;

  // Try 20YY first.
  let year = 2000 + yy;
  let date = buildUtcDate(year, mm, dd);
  if (date === null) return null;          // Feb 31 etc.

  if (date > now) {
    // 20YY is in the future → use 19YY.
    year = 1900 + yy;
    date = buildUtcDate(year, mm, dd);
    if (date === null) return null;
    // Reject ages above MAX_AGE_YEARS.
    const age = computeAge(date, now);
    if (age > MAX_AGE_YEARS) return null;
  }

  return date;
}

/** Build a UTC Date, returning null if (year, month, day) isn't a real date. */
function buildUtcDate(year: number, month: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

function computeAge(dob: Date, at: Date): number {
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const m = at.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let doubleIt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;       // '0' is 48
    if (d < 0 || d > 9) return false;
    if (doubleIt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleIt = !doubleIt;
  }
  return sum % 10 === 0;
}
