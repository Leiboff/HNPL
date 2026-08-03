// ─── Checkout pay-step idempotency window ──────────────────────────────────
//
// The pivotal commit point in initiateCheckout mints a Peach Checkout
// V2 session while it holds a fresh payments row + a
// stamped peach_payment_id. If a slow Peach roundtrip stalls the
// action and the patient submits Pay again (e.g. via a browser
// refresh), we don't want to:
//   - tear down and recreate the payments rows TWICE in rapid
//     succession (wasted work, and momentary states where the row
//     is missing on the second call's read),
//   - mint a second Peach checkout when the first redirect URL is
//     still in flight to the browser.
//
// Idempotency guard: if there's already a freshly-stamped instalment-1
// row (peach_payment_id set, created within RECENT_PAY_WINDOW_MS), the
// current attempt is a near-immediate retry and we throttle it.
//
// Window is SHORT (5s) — well under any legitimate user gap between
// genuine retries (a Peach decline takes longer than that to come
// back). The discriminator + plan-ownership reuse handles legitimate
// retries after that 5s window naturally.

export const RECENT_PAY_WINDOW_MS = 5_000;

export type RecentPayment = {
  created_at:        string;
  peach_payment_id:  string | null;
};

/**
 * Has a recent Pay attempt already stamped its Peach reference?
 *
 * The dual condition matters:
 *   - `peach_payment_id !== null` means initiateCheckout did get
 *     past creating the payments row + stamping the reference.
 *     A missing reference means the previous attempt errored out
 *     earlier and we shouldn't throttle the retry.
 *   - `created_at` within the window scopes the throttle to the
 *     hang-retry case only.
 *
 * Pure for testability; the SQL row fetch lives in the action.
 */
export function isRapidRepeatPayAttempt(
  recent:  RecentPayment | null,
  now:     number,
  windowMs: number = RECENT_PAY_WINDOW_MS,
): boolean {
  if (!recent) return false;
  if (!recent.peach_payment_id) return false;
  const created = new Date(recent.created_at).getTime();
  if (!Number.isFinite(created)) return false;
  const age = now - created;
  return age >= 0 && age < windowMs;
}
