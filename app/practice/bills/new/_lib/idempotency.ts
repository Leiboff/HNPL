// ─── Bill-creation idempotency window ──────────────────────────────────────
//
// The hang-then-refresh-then-resubmit problem (server action stalled
// on a slow outbound call, provider refreshes, server still finished
// the work, second submit creates a duplicate bill + invitation) is
// closed by checking for a near-identical plan within a SHORT window
// before inserting.
//
// Window is deliberately SHORT (8s, matching our outbound fetch
// timeouts) so that legitimate "bill the same patient the same
// amount twice in a row" — repeat procedure, correction — is NOT
// blocked. Eight seconds is enough to catch a panicked
// click-refresh-click cycle but well below any natural cadence for
// a deliberate second bill.
//
// Pure function so the rule is testable; the SQL-driven row fetch
// lives at the call site in actions.ts.

export const RECENT_BILL_WINDOW_MS = 8_000;

export type CandidatePlan = {
  created_at:    string;
  total_amount:  number | string;
};

/**
 * Does any of the given recent plans (same practice + same patient OR
 * same invitation-email, supplied by the caller) duplicate the new
 * bill?
 *
 *   - Same `total_amount` (cast-safe — PostgreSQL NUMERIC arrives
 *     as a string from PostgREST).
 *   - Created within `windowMs` of `now`.
 *
 * The caller queries the rows in the right scope (existing patient =
 * by patient_id; new patient = by invitation email join); this
 * function decides whether any one of them disqualifies the new
 * submission.
 */
export function isDuplicateBill(
  candidates:   CandidatePlan[],
  newAmount:    number,
  now:          number,
  windowMs:     number = RECENT_BILL_WINDOW_MS,
): boolean {
  return candidates.some((c) => {
    if (Number(c.total_amount) !== Number(newAmount)) return false;
    const created = new Date(c.created_at).getTime();
    if (!Number.isFinite(created)) return false;
    const age = now - created;
    return age >= 0 && age < windowMs;
  });
}
