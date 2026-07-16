// ─── Payment provider interface ─────────────────────────────────────
//
// The thin surface the domain code calls into. There is one live
// implementation (Peach Payments — lib/payments/peach). Paystack was
// removed in the 0076 swap; historic Paystack columns remain in the
// DB but no code path targets them. 0077 moved from Peach OPPWA
// COPYandPAY to Peach Checkout V2 (CIT / capture) + recurring
// card-on-file API (MIT / instalments 2+).
//
// Two credential surfaces — the client hides this but the interface
// carries the invariants:
//
//   • Checkout V2 (CIT) — OAuth-authed calls to /v2/checkout*.
//     Used by createCheckout + getCheckoutStatus. Tokenises the card
//     and captures the first instalment in one embedded widget.
//
//   • Recurring (MIT) — static Bearer against /v1/registrations/{id}/
//     payments and /v1/payments/{id}. Used by chargeSavedCard,
//     deleteRegistration, refund. Cannot be authenticated with a
//     Checkout-product token — Peach provisions the recurring rail
//     as a separate product family with its own credentials.
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
// State authority:
//   • CIT (widget) charges: the WEBHOOK is authoritative. createCheckout
//     returns a checkoutId; getCheckoutStatus lets the return route
//     check status while the webhook lands in parallel.
//   • MIT (recurring) charges: the SYNCHRONOUS response is authoritative
//     — chargeSavedCard returns success/pending/rejected/error based
//     on the result.code on the POST response. The webhook is a bonus
//     reconciliation source but NOT waited on.

export type ChargeStatus =
  | 'success'          // Provider accepted the charge (post-3DS if applicable)
  | 'pending'          // Provider queued the charge (webhook is authoritative)
  | 'rejected'         // Provider rejected (card decline, fraud check, etc.)
  | 'error';           // Transport / bad request / provider outage

export type ChargeResult = {
  status:                ChargeStatus;
  providerPaymentId?:    string;      // The transaction's OWN top-level id (used later for GET status / refund).
  // The echoed root of the stored-credential chain — Peach returns this
  // on a REPEATED response as standingInstruction.initialTransactionId,
  // pointing at the INITIAL/CIT id that established the credential.
  // NEVER equal to providerPaymentId on an MIT response: providerPaymentId
  // is the MIT transaction's own id, initialTransactionId is the CIT
  // root it's threaded off. Absent when Peach doesn't echo it (older
  // credentials, or configurations where the field is only on CITs).
  initialTransactionId?: string;
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
  //   mode=REPEATED, source=MIT, type=INSTALLMENT (default, fixed-instalment plan)
  //   + initialTransactionId = the id of the FIRST transaction that
  //   established this card-on-plan pair.
  //
  // Fallback: when the plan has no initialTransactionId yet (e.g. the
  // very first MIT charge on a plan whose card was tokenised via a
  // registration-only checkout, before Flow A captured it), the caller
  // passes type=UNSCHEDULED and omits initialTransactionId — Peach
  // accepts an UNSCHEDULED MIT without the reference.
  //
  // This call ALWAYS routes through the RECURRING channel — MIT
  // charges must go through the recurring credentials or the acquirer
  // will apply 3DS rules that will decline.
  standingInstruction:   {
    mode:                  'INITIAL' | 'REPEATED';
    source:                'CIT' | 'MIT';
    type:                  'UNSCHEDULED' | 'RECURRING' | 'INSTALLMENT';
    initialTransactionId?: string;
  };
};

export type CheckoutCreateParams = {
  amountCents:           number;      // Integer cents (ZAR) — server-computed only
  merchantTransactionId: string;
  currency?:             string;      // Defaults to 'ZAR'
  paymentType?:          'DB' | 'PA';
  createRegistration?:   boolean;     // true → widget also captures a reusable card
  standingInstruction?:  {
    mode:                  'INITIAL' | 'REPEATED';
    source:                'CIT' | 'MIT';
    type:                  'UNSCHEDULED' | 'RECURRING' | 'INSTALLMENT';
    initialTransactionId?: string;
  };
  customer?: {
    email?:    string | null;
    givenName?: string | null;
    surname?:   string | null;
  };
  customParameters?: Record<string, string>;
  // shopperResultUrl travels to the browser and back — the widget's
  // onCompleted callback navigates the browser to this URL, appending
  // ?checkoutId={id} so the return route can query final status.
  shopperResultUrl?: string;
  // Site origin, used as the Origin header on the /v2/checkout POST.
  // Defaults to NEXT_PUBLIC_APP_URL. Peach requires the origin to be
  // in the Checkout Dashboard's allowlist.
  origin?: string;
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
  /**
   * Create a Checkout V2 session for the embedded widget. Server-only.
   * OAuth token is fetched + cached transparently inside the client.
   * Returns a checkoutId — the browser mounts checkout.js with this id.
   */
  createCheckout(params: CheckoutCreateParams): Promise<CheckoutCreated>;

  /**
   * Fetch the payment status behind a Checkout V2 session. Server-only.
   * Takes the checkoutId returned by createCheckout (NOT a resourcePath;
   * V2's status endpoint takes the id directly). The return route calls
   * this after the widget's onCompleted event navigates the browser
   * back to the shopperResultUrl.
   */
  getCheckoutStatus(checkoutId: string): Promise<PaymentStatus>;

  /**
   * Server-to-server MIT charge against a stored registration.
   * Always uses the recurring credential set (never Checkout OAuth).
   * The response is authoritative — status/resultCode reflect the
   * final outcome, not a pending state.
   */
  chargeSavedCard(params: ChargeSavedCardParams): Promise<ChargeResult>;

  /**
   * Delete a stored registration.
   *
   * TODO(dina): confirm from Dashboard whether registration deletion
   * uses the recurring credentials or the checkout credentials. This
   * implementation currently routes through the recurring surface,
   * which matches the endpoint that CREATES registrations for MIT
   * (/v1/registrations/{id}/payments). If a live deletion returns an
   * auth error, swap to the checkout surface.
   */
  deleteRegistration(registrationId: string): Promise<{ ok: boolean; raw?: unknown }>;

  /**
   * Refund a prior payment by provider id. Peach spec (Manage payments):
   *   POST /v1/payments/{id} with paymentType=RF (refund) — reduces a
   *   prior debit; the standard flow for our DB (debit) instalments.
   *   POST /v1/payments/{id} with paymentType=RV (reversal) — voids a
   *   preauth (PA) that hasn't been captured yet. We only issue DB
   *   today, so RF is the default; RV is exposed for future PA flows.
   *
   * TODO(dina): confirm from Dashboard whether a refund of a
   * Checkout-V2-captured payment (i.e. instalment 1) must be booked
   * against the Checkout entity or the recurring entity. The current
   * default is 'recurring' — same channel MIT instalments 2+ live on.
   * If Peach rejects a CIT refund routed to recurring, we'll need
   * per-payment routing that mirrors the entity the original charge
   * used (payments.payment_provider + the checkout/recurring split).
   */
  refund(
    providerPaymentId: string,
    amountCents: number,
    merchantTransactionId: string,
    opts?: { paymentType?: 'RF' | 'RV' },
  ): Promise<RefundResult>;
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
