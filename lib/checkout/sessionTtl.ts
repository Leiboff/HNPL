/**
 * How long a QR checkout session stays scannable.
 *
 * Shared by both issuing surfaces since the delivery toggle landed: the
 * till (issueCounterSession) and the practice dashboard (createBill with
 * delivery='qr'). A QR bill assumes the patient is standing there, so the
 * window is short by design — an abandoned code stops being scannable
 * quickly rather than lingering as a live payment link on a screen.
 *
 * Both surfaces must use the SAME value: expire_stale_checkout_session
 * (migration 0085) is the single expiry authority for the table and reads
 * expires_at, so two surfaces writing different windows would be two
 * different products sharing one row type.
 */
export const CHECKOUT_SESSION_TTL_MS = 2 * 60 * 1000; // ~2 minutes
