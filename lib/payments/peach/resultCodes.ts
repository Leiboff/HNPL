// ─── OPPWA result-code classifier ───────────────────────────────────
//
// Peach Payments returns a `result.code` on every response. The full
// registry is documented under the "Response codes" reference; the
// coarse-grained classification below is the same one the
// docs' own examples use, and is what we act on in code.
//
//   SUCCESS       — /^(000\.000\.|000\.100\.1|000\.[36])/
//                   000.000.*   integrator test / production success
//                   000.100.1xx production success
//                   000.3xx.xxx result manually reviewed / risk-acceptable
//                   000.6xx.xxx result manually confirmed as successful
//
//   SUCCESS (risk-flagged, CARD ALREADY CHARGED) —
//                   /^(000\.400\.0[^3]|000\.400\.100)/
//                   Peach's SECOND documented "successful" family:
//                   "successfully processed transactions that should be
//                   manually reviewed". Per Peach support ("Response
//                   codes" / "How to determine transaction status"), for
//                   these codes "the transaction is successful and the
//                   customer's card has been charged" — a risk RULE just
//                   flagged it for review. Codes: 000.400.000, .010,
//                   .020, .040, .060, .090, .100 (000.400.03x is the
//                   ONE excluded 000.400.0xx subfamily — genuine 3DS
//                   failures — hence the [^3]).
//
//                   ROOT CAUSE 2026-08-01 (false decline on a real,
//                   approved first instalment): this family was MISSING
//                   here, so a cold patient's first card that tripped a
//                   sandbox risk rule (e.g. 000.400.000) fell through
//                   BOTH success and pending regexes → classified
//                   'rejected' → the completion page showed "Your card
//                   was declined" for a payment Peach had actually
//                   captured. Adding it is the fix.
//
//   PENDING       — /^(000\.200|100\.400\.500|800\.400\.5)/
//                   The transaction is queued at Peach's end (000.200.*),
//                   or awaiting the acquirer / bank / external
//                   confirmation (100.400.500, 800.400.5xx — Peach's
//                   documented "pending, can take days" family). Poll
//                   or wait for the webhook — NEVER a decline verdict.
//
//   REJECTED_*    — everything else.
//
// We never derive DOMAIN behaviour from the exact code; the webhook
// is authoritative on flipping instalment state. This classifier is
// used at three narrow points:
//   1. checkout-return route to decide whether to redirect to done vs
//      the retry UX;
//   2. MIT charge return path — to record `success` vs `rejected` vs
//      `pending` on our provider adapter's return value;
//   3. tests — to assert the exact regex.

export const SUCCESS_RE = /^(000\.000\.|000\.100\.1|000\.[36])/;
// Successful, but flagged for manual review — the card WAS charged.
// Kept as its own exported constant (not folded into SUCCESS_RE) so the
// distinction stays legible: these need eventual operator review, but
// they are NOT declines.
export const SUCCESS_MANUAL_REVIEW_RE = /^(000\.400\.0[^3]|000\.400\.100)/;
export const PENDING_RE = /^(000\.200|100\.400\.500|800\.400\.5)/;

// Fine-grained rejection subclasses — useful for logs / retry policy.
// Right now the domain treats every rejection uniformly, so these are
// exported only for grepability + future work.
export const REJECT_3DS_RE          = /^(000\.400\.[0-9]{3}|000\.400\.1[0-9]{2})/;
export const REJECT_COMMUNICATION_RE = /^(900\.[1-9][0-9]{2}\.[0-9]{3})/;
export const REJECT_RISK_RE          = /^(100\.400\.[0-9]{3})/;
export const REJECT_ASYNC_RE         = /^(200\.[1-9][0-9]{2}\.[0-9]{3})/;

export type ClassifiedStatus = 'success' | 'pending' | 'rejected';

export function classifyResultCode(code: string | null | undefined): ClassifiedStatus {
  if (!code) return 'rejected';
  if (SUCCESS_RE.test(code)) return 'success';
  // Risk-flagged BUT charged — treat as success (activate the plan; the
  // first instalment money is in). Ordered before PENDING/REJECTED so a
  // 000.400.0xx success is never mistaken for a decline.
  if (SUCCESS_MANUAL_REVIEW_RE.test(code)) return 'success';
  if (PENDING_RE.test(code)) return 'pending';
  return 'rejected';
}
