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
//   PENDING       — /^(000\.200|100\.400\.500)/
//                   The transaction is either queued at Peach's end
//                   (000.200.*) or awaiting the acquirer / bank. Poll
//                   or wait for the webhook.
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
export const PENDING_RE = /^(000\.200|100\.400\.500)/;

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
  if (PENDING_RE.test(code)) return 'pending';
  return 'rejected';
}
