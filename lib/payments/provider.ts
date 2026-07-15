// ─── Payment provider interface ─────────────────────────────────────
//
// The thin surface the domain code calls into. There is one live
// implementation (Peach Payments — lib/payments/peach). Paystack was
// removed in the 0076 swap; historic Paystack columns remain in the
// DB but no code path targets them.
//
// Amount conventions:
//   • All `amountCents` values are integers.
//   • Rands ↔ cents happens ONCE at the provider boundary, not sprinkled
//     through domain code.
//
// Identity conventions:
//   • `merchantTransactionId` is our idempotency key on every charge;
//     the same string is echoed on the webhook so we can reconcile.
//     Format follows the existing convention:
//       hnpl_co_<20 hex>       — checkout first instalment
//       hnpl_<16 hex>_a<n>     — MIT recurring attempt n
//       hnpl_settle_<uuid>     — settlement charge
//       hnpl_reg_<uuid>        — standalone card-registration
//
// The result of a charge is NEVER final until the webhook fires. This
// interface returns the transport-level outcome (accepted / rejected /
// pending / transport-error) and the provider payment id; the domain
// waits for the webhook to flip instalment state.

export type ChargeStatus =
  | 'success'          // Provider accepted the charge (post-3DS if applicable)
  | 'pending'          // Provider queued the charge (webhook is authoritative)
  | 'rejected'         // Provider rejected (card decline, fraud check, etc.)
  | 'error';           // Transport / bad request / provider outage

export type ChargeResult = {
  status:                ChargeStatus;
  providerPaymentId?:    string;      // Peach payment id (used later for GET status / refund)
  resultCode?:           string;      // Raw provider result code (000.100.110, etc.)
  resultDescription?:    string;      // Human-readable
  raw?:                  unknown;     // Full provider response, for logs
};

export type ChargeSavedCardParams = {
  registrationId:        string;      // Peach registration id — the reusable token
  amountCents:           number;      // Integer cents (ZAR)
  merchantTransactionId: string;      // Our idempotency key
  currency?:             string;      // Defaults to 'ZAR'
  // ── card-on-file standing instruction ──
  //
  // For merchant-initiated repeats we send:
  //   type=UNSCHEDULED, mode=REPEATED, source=MIT
  //
  // Other combos (INITIAL/CIT, RECURRING/*, INSTALLMENT/*) are covered
  // by other flows (widget charges + registration-only) and don't come
  // through this fn.
  standingInstruction:   {
    mode:   'INITIAL' | 'REPEATED';
    source: 'CIT' | 'MIT';
    type:   'UNSCHEDULED' | 'RECURRING' | 'INSTALLMENT';
  };
};

export type CheckoutCreateParams = {
  amountCents:           number;      // Integer cents (ZAR) — server-computed only
  merchantTransactionId: string;
  currency?:             string;      // Defaults to 'ZAR'
  paymentType?:          'DB' | 'PA';
  createRegistration?:   boolean;     // true → widget also captures a reusable card
  standingInstruction?:  {
    mode:   'INITIAL' | 'REPEATED';
    source: 'CIT' | 'MIT';
    type:   'UNSCHEDULED' | 'RECURRING' | 'INSTALLMENT';
  };
  customer?: {
    email?:    string | null;
    givenName?: string | null;
    surname?:   string | null;
  };
  customParameters?: Record<string, string>;
};

export type CheckoutCreated = {
  checkoutId: string;
  raw?:       unknown;
};

export type PaymentStatus = {
  status:              ChargeStatus;
  providerPaymentId?:  string;
  merchantTransactionId?: string;
  amountCents?:        number;
  resultCode?:         string;
  resultDescription?:  string;
  // Present after a registration-creating checkout.
  registrationId?:     string;
  card?: {
    brand?:       string | null;
    last4?:       string | null;
    expiryMonth?: number | null;
    expiryYear?:  number | null;
    holder?:      string | null;
    binCountry?:  string | null;
  };
  raw?: unknown;
};

export type RefundResult = {
  status:                ChargeStatus;
  providerRefundId?:     string;
  resultCode?:           string;
  raw?:                  unknown;
};

export interface PaymentProvider {
  /** Create a checkout for the COPYandPAY widget. Server-only. */
  createCheckout(params: CheckoutCreateParams): Promise<CheckoutCreated>;

  /** Fetch the payment status behind a widget `resourcePath`. Server-only. */
  getCheckoutStatus(resourcePath: string): Promise<PaymentStatus>;

  /** Fetch the status of a payment by provider id. Server-only. */
  getPaymentStatus(providerPaymentId: string): Promise<PaymentStatus>;

  /** Server-to-server MIT charge against a stored registration. */
  chargeSavedCard(params: ChargeSavedCardParams): Promise<ChargeResult>;

  /** Delete a stored registration. */
  deleteRegistration(registrationId: string): Promise<{ ok: boolean; raw?: unknown }>;

  /** Refund a prior payment by provider id. */
  refund(providerPaymentId: string, amountCents: number, merchantTransactionId: string): Promise<RefundResult>;
}

// ─── Provider singleton ─────────────────────────────────────────────
//
// One live implementation. If we ever need a fake for tests, this is
// the seam — but the existing tests use vi.mock on the concrete
// modules under lib/payments/peach so we don't need a swap here.

import { PeachProvider } from './peach/client';

let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;
  cached = new PeachProvider();
  return cached;
}

// Test hook — reset the cached provider between tests.
export function __resetProviderForTests(): void {
  cached = null;
}
