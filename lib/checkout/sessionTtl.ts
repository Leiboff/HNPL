/**
 * How long a QR checkout session lives — in two windows, not one.
 *
 * WHY TWO
 *   A single window was doing two jobs, and only one of them had a
 *   security argument behind it.
 *
 *   SCAN WINDOW — how long an UNSCANNED QR stays scannable. This is the
 *   real property: a stranger photographing a code off a screen. Short.
 *
 *   COMPLETION WINDOW — how long the patient has once they HAVE scanned
 *   and are on their own phone. Extending this costs nothing against that
 *   threat, and the mandatory-SA-ID work strengthens it further: the plan
 *   is keyed to an ID, so a stranger who scanned a photographed code still
 *   cannot claim it unless their own ID matches.
 *
 *   Conflating them meant a first-time patient at a counter — ID, OTP,
 *   affordability, terms, card — had two minutes for all of it, and
 *   overrunning did not merely lapse the link: expire_stale_checkout_
 *   session DECLINES the plan, which is terminal. A slow signup destroyed
 *   the bill.
 *
 * WHERE EACH ONE LIVES
 *   The scan window is set by whichever surface issues the bill, so it
 *   lives here. The completion window is applied by
 *   stamp_checkout_session_scanned (migration 0098) and is HARDCODED in
 *   SQL — that function is anon-callable, so a caller-supplied interval
 *   would let anyone mint an arbitrarily long-lived session. The constant
 *   below mirrors it for the app's own use, and a test pins the two equal.
 */

/**
 * Till-issued QR: the patient is standing at the counter, and a till screen
 * faces a queue continuously.
 */
export const CHECKOUT_SCAN_TTL_TILL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Dashboard-issued QR: deliberately longer than the till's.
 *
 * The threat being priced is a stranger reading the code off a screen, and
 * the exposure genuinely differs — a practice manager's laptop does not
 * face a waiting room the way a till does, and a dashboard bill may be
 * prepared minutes before the patient reaches the desk. This is the one
 * place the two surfaces should NOT match; everything downstream of the
 * scan is identical.
 */
export const CHECKOUT_SCAN_TTL_DASHBOARD_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Applied at scan, on both surfaces — once scanned, which surface issued
 * the bill is irrelevant.
 *
 * MUST equal the INTERVAL in stamp_checkout_session_scanned (0098).
 * Deliberately NOT extended by activity: a signup running past an hour has
 * already failed by other means, a heartbeat would be a new write path and
 * a new abuse surface on an anon-callable RPC, and the failure mode of a
 * fixed hour is recoverable (re-issue) while the complexity would be
 * permanent.
 */
export const CHECKOUT_COMPLETION_TTL_MS = 60 * 60 * 1000; // 1 hour
