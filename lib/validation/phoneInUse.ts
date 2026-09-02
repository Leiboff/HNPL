// ─── Recognising migration 0139's refusal ─────────────────────────────────
//
// 0139 refuses a patient row becoming verified on a cell number another
// patient has already verified, raising `unique_violation` (23505).
//
// Matched on the ERROR CODE, never the message text. The message is written
// for an operator reading a log and will be reworded one day; the code is
// the contract. A string match here would fail open on that reword — the
// promotion would report "unknown", the customer would see "something went
// wrong", and the actual reason would be invisible to everyone.

/** PostgreSQL unique_violation. */
const UNIQUE_VIOLATION = '23505';

export function isPhoneAlreadyVerifiedElsewhere(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code !== UNIQUE_VIOLATION) return false;
  // profiles carries other unique constraints (id, email), and a 23505 from
  // one of those is a different bug that must not be reported to a customer
  // as a phone problem. 0139 is the only one reachable from a phone write,
  // but the constraint name is checked anyway so this stays true if another
  // is ever added.
  return /already verified on another account|phone/i.test(error.message ?? '');
}
