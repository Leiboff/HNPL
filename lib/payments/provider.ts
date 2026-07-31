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
  // V2 door is PURCHASE-ONLY. Card vaulting lives on the separate
  // COPYandPAY door — see CardRegistrationCreateParams below and
  // lib/payments/peach/copyandpay/registration.ts. Zero-amount is
  // rejected at the client boundary.
  amountCents:           number;      // Integer cents (ZAR) — server-computed, MUST be > 0.
  merchantTransactionId: string;      // Must be ≤ 16 chars (Peach V2 limit; use mintPeachRef).
  currency?:             string;      // Defaults to 'ZAR'
  paymentType?:          'DB' | 'PA'; // DB debit (default); PA reserved for future preauth flows.
  createRegistration?:   boolean;     // true → widget also captures a reusable card (Flow A first CIT).
  // ── Payment-method restriction (Peach V2 /v2/checkout) ────────────
  //
  // We are card-only by design. Wallet methods (Apple Pay, Google Pay)
  // return SINGLE-USE tokens with no reusable registrationId — Peach
  // won't allow the subsequent MIT charges on instalments 2-N against
  // a wallet token, so a wallet-paid first instalment would leave the
  // plan uncollectable. Force the V2 widget to card only.
  //
  // Field names per developer.peachpayments.com/reference/post_v2-checkout:
  //   defaultPaymentMethod  — selects the default tab in the widget.
  //   forceDefaultMethod    — when true, ONLY the default is shown
  //                           (all other tabs / methods suppressed).
  //
  // We whitelist these at the client boundary alongside standingInstruction
  // fields, so a caller can pass them without a client change.
  defaultPaymentMethod?: 'CARD';
  forceDefaultMethod?:   boolean;
  // Peach V2 /v2/checkout standingInstruction — the V2 schema only
  // (developer.peachpayments.com/reference/post_v2-checkout).
  //
  // CRITICAL: V2 Checkout does NOT accept the OPPWA fields `source`
  // (CIT/MIT) or `initialTransactionId`. Those are recurring-API
  // vocabulary — legitimately used on /v1/registrations/{id}/payments
  // via ChargeSavedCardParams (Flow C), which lives on its own type
  // below and is untouched. V2's rejection of source came through as
  // {"standingInstruction.source": "unknown field"} on 2026-07-30.
  //
  //   type                 UNSCHEDULED | INSTALLMENT | RECURRING
  //   mode                 INITIAL | REPEATED
  //   expiry               YYYY-MM-DD — Mastercard default 9999-12-31
  //   frequency            INTEGER 1-9999 (days between authorisations)
  //   numberOfInstallments INTEGER 1-999 — required for INSTALLMENT+INITIAL
  //   recurringType        SUBSCRIPTION | STANDING_ORDER — for RECURRING only
  //   industryPractice     MIT-follow-up enum — N/A on our INITIAL/CIT
  standingInstruction?:  {
    mode:                  'INITIAL' | 'REPEATED';
    type:                  'UNSCHEDULED' | 'RECURRING' | 'INSTALLMENT';
    expiry?:                string;
    frequency?:             number;
    numberOfInstallments?:  number;
    recurringType?:         'SUBSCRIPTION' | 'STANDING_ORDER';
    industryPractice?:      'INCREMENTAL_AUTH' | 'RESUBMISSION' | 'REAUTHORIZATION' | 'DELAYED_CHARGES' | 'NO_SHOW';
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

// ─── Card-registration surface (COPYandPAY, Flow B only) ────────────
//
// Card-vault flow lives on a SEPARATE door from Checkout V2 (Flow A).
// See lib/payments/peach/copyandpay/registration.ts for the full
// dual-door rationale. Distinct methods so a caller can't confuse
// the two — e.g. accidentally passing an amount to a vault call.

export type CardRegistrationCreateParams = {
  merchantTransactionId: string;   // 1-16 chars — use mintPeachRef('r', ...).
  shopperResultUrl:      string;   // Widget navigates browser here with ?resourcePath=...
  customer?: {
    email?:     string | null;
    givenName?: string | null;
    surname?:   string | null;
  };
  customParameters?: Record<string, string>;
};

export type CardRegistrationCreated = {
  checkoutId: string;
  raw?:       unknown;
};

export interface PaymentProvider {
  /**
   * Create a Checkout V2 session for the embedded widget. Server-only.
   * OAuth token is fetched + cached transparently inside the client.
   * Returns a checkoutId — the browser mounts checkout.js with this id.
   *
   * Purchase-shaped surface (Flow A). For the vault-only Flow B path,
   * use createCardRegistration instead.
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

  /**
   * Create a COPYandPAY registration-only checkout (Flow B — card vault).
   * Distinct from createCheckout so callers cannot accidentally send
   * a purchase-shaped body (with amount / paymentType) to a vault flow.
   * Runs on the recurring credential family (SAME creds as MIT charges)
   * against the recurring host. See
   * lib/payments/peach/copyandpay/registration.ts for the dual-door
   * rationale + params matrix.
   */
  createCardRegistration(params: CardRegistrationCreateParams): Promise<CardRegistrationCreated>;

  /**
   * Fetch status after a COPYandPAY registration widget returns. The
   * widget appends `?resourcePath=/v1/checkouts/{id}/payment` on
   * shopperResultUrl (same suffix as a payment status). The response
   * carries registrationId + card metadata for a successful vault.
   */
  getCardRegistrationStatus(resourcePath: string): Promise<PaymentStatus>;
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
