// ─── Peach captured/real response fixtures ──────────────────────────
//
// Ground-truth bodies for the integration suite (captured-body-
// extraction.test.ts). Each fixture is annotated with its PROVENANCE
// (real prod capture vs doc-shaped synthetic) and a REGRESSION note
// tying it to one of the five historical field-shape bugs, so a
// reviewer knows exactly what each fixture defends.
//
// NOT imported by production code — test-only.
//
// The five historical bugs this suite must fail against if reintroduced:
//   B1. classifier missing the 000.400.0xx "charged, manual-review"
//       success family → false decline of an approved first instalment.
//   B2. V2 status body is FLAT dot-notation ('result.code'), not nested
//       → a successful charge read as undefined → classified 'rejected'.
//   B3. stale 'hnpl_co_' ref-prefix guard that rejected every compact
//       16-char ref after the ref migration.
//   B4. paymentBrand is TOP-LEVEL, not card.paymentBrand → brand "Card",
//       NULL signature, dedup globally broken.
//   B5. add-card idempotency keyed on a 5-min time window, not the
//       checkout's registrationId → a legit second card swallowed.

// ─── V2 checkout status — REAL PROD captures ────────────────────────

/**
 * REAL prod capture — checkout 0ea34011d7924ed9aa4ede361c758e5e.
 * FLAT dot-notation body from GET /v2/checkout/{id}/status.
 * REGRESSION B2: reading `body.result.code` (nested) returns undefined
 * against this shape → the 000.100.110 success was classified 'rejected'
 * in prod. The suite asserts toPaymentStatus reads it flat → 'success'.
 * (This real body carries `card.paymentBrand` nested; the top-level
 * placement B4 defends is pinned by V2_STATUS_TOP_LEVEL_BRAND below.)
 */
export const V2_STATUS_FLAT_0EA3: Record<string, unknown> = {
  'result.code':        '000.100.110',
  'result.description': "Request successfully processed in 'Merchant in Integrator Test Mode'",
  id:                    'pay-flat-0ea3',
  merchantTransactionId: 'bnc2b23vwkixm97y',
  amount:                '92.00',
  currency:              'ZAR',
  'card.bin':            '400000',
  'card.last4Digits':    '0042',
  'card.holder':         'Jane Doe',
  'card.expiryMonth':    '12',
  'card.expiryYear':     '2030',
  'card.paymentBrand':   'VISA',
  registrationId:        '8ac7a49f9fb7fec7019fbf26b73e7852',
};

/**
 * REAL prod capture — checkout 03e9c095…, ref bnc26xa9mdv8z0yi.
 * FLAT status body that also carries BRACKETED-FLAT customParameters
 * keys (`customParameters[SHOPPER_patientId]`), NOT a nested object.
 * REGRESSION (audit finding #4 / P2): the webhook backstop that reads
 * `payload.customParameters?.SHOPPER_patientId` (nested) never resolves
 * a patient against this shape. Phase 5 fixes the reader; this fixture
 * pins the real bracketed shape now.
 */
export const V2_STATUS_FLAT_03E9: Record<string, unknown> = {
  'result.code':        '000.100.110',
  'result.description': "Request successfully processed in 'Merchant in Integrator Test Mode'",
  id:                    'pay-03e9c095',
  merchantTransactionId: 'bnc26xa9mdv8z0yi',
  amount:                '92.00',
  currency:              'ZAR',
  'card.bin':            '400000',
  'card.last4Digits':    '0042',
  'card.paymentBrand':   'VISA',
  registrationId:        '8ac7a49f9fb7fec7019fbf26b73e7852',
  'customParameters[SHOPPER_purpose]':   'checkout_first_payment',
  'customParameters[SHOPPER_planId]':    '43dd8174-0000-0000-0000-000000000000',
  'customParameters[SHOPPER_paymentId]': 'pmt-1',
  'customParameters[SHOPPER_patientId]': 'usr-1',
  'customParameters[SHOPPER_token]':     'tok-1',
};

// ─── V2 status — DOC-SHAPED synthetic (documented placements) ───────

/**
 * DOC-SHAPED: paymentBrand at the TOP LEVEL (sibling of card.*), the
 * placement Peach documents. REGRESSION B4: reading only
 * `card.paymentBrand` yields undefined → brand "Card" → null signature.
 */
export const V2_STATUS_TOP_LEVEL_BRAND: Record<string, unknown> = {
  'result.code':      '000.100.110',
  id:                  'pay-top',
  merchantTransactionId: 'bnctoplevelbrand',
  amount:              '92.00',
  registrationId:      'reg-top',
  paymentBrand:        'VISA',        // top-level, no card.paymentBrand
  'card.last4Digits':  '0042',
  'card.expiryMonth':  '02',
  'card.expiryYear':   '2031',
  'card.holder':       'Jane Doe',
};

/** DOC-SHAPED: both placements present — top-level must win. */
export const V2_STATUS_BOTH_BRANDS: Record<string, unknown> = {
  'result.code':       '000.100.110',
  id:                   'pay-both',
  merchantTransactionId: 'bncbothbrands',
  amount:               '92.00',
  registrationId:       'reg-both',
  paymentBrand:         'VISA',
  'card.paymentBrand':  'MASTERCARD',
  'card.last4Digits':   '0042',
};

/** NESTED twin of V2_STATUS_FLAT_0EA3 — proves both shapes parse equal. */
export const V2_STATUS_NESTED: Record<string, unknown> = {
  result: { code: '000.100.110', description: 'Request successfully processed' },
  id:                    'pay-nested',
  merchantTransactionId: 'bncnestedxxxxx',
  amount:                '92.00',
  currency:              'ZAR',
  registrationId:        '8ac7a49f9fb7fec7019fbf26b73e7852',
  card: { bin: '400000', last4Digits: '0042', holder: 'A B', expiryMonth: '12', expiryYear: '2030', paymentBrand: 'VISA' },
};

/** FLAT decline body — 800.100.152. */
export const V2_STATUS_DECLINE: Record<string, unknown> = {
  'result.code':        '800.100.152',
  'result.description': 'transaction declined by authorization system',
  id:                    'pay-decline',
  merchantTransactionId: 'bncdeclinexxxx',
  amount:                '92.00',
};

// ─── Result-code families (classifier) ──────────────────────────────

/**
 * REGRESSION B1: the 000.400.0xx "successful, flagged for manual review —
 * the card WAS charged" family. Missing this classified an approved
 * first instalment as 'rejected'. 000.400.03x is the ONE excluded
 * subfamily (genuine 3DS failure).
 */
export const RESULT_CODES = {
  success:        ['000.000.000', '000.100.110', '000.300.000', '000.600.000'],
  chargedReview:  ['000.400.000', '000.400.010', '000.400.100'],   // B1 — success
  declines3ds:    ['000.400.030', '000.400.101'],                  // rejected
  pending:        ['000.200.000', '100.400.500', '800.400.500'],
  rejected:       ['800.100.152', '100.100.101'],
} as const;

// ─── Webhook form-urlencoded event bodies ───────────────────────────
//
// Structurally faithful (values synthetic). Peach event deliveries are
// application/x-www-form-urlencoded with dotted names for nested paths
// and BRACKETED names for customParameters.

/** PAYMENT event — the instalment-1 success shape. */
export const WEBHOOK_PAYMENT_SUCCESS =
  'id=peach-payment-abc' +
  '&merchantTransactionId=bnc2b23vwkixm97y' +
  '&amount=92.00&currency=ZAR&paymentType=DB' +
  '&result.code=000.100.110' +
  '&result.description=Successfully%20processed' +
  '&card.last4Digits=4242&card.paymentBrand=VISA' +
  '&card.expiryMonth=12&card.expiryYear=2030' +
  '&registrationId=peach-reg-abc&checkoutId=chk-abc' +
  '&type=PAYMENT';

/**
 * Card-registration (Flow B) PAYMENT event carrying BRACKETED-FLAT
 * customParameters. REGRESSION (finding #4 / P2): the webhook backstop
 * reads these nested and fails; parseFormEventBody keeps them as a flat
 * bracketed key. Phase 5 fixes the reader + adds a resolves-patient test.
 */
export const WEBHOOK_CARD_REG =
  'id=peach-reg-payment' +
  '&merchantTransactionId=bnrregistrationx' +
  '&result.code=000.100.110' +
  '&registrationId=peach-reg-xyz' +
  '&card.last4Digits=4242&card.paymentBrand=VISA' +
  '&customParameters%5BSHOPPER_patientId%5D=patient-1' +
  '&customParameters%5BSHOPPER_purpose%5D=card_registration' +
  '&type=PAYMENT';

/** REGISTRATION lifecycle event — DELETED. */
export const WEBHOOK_REGISTRATION_DELETED =
  'type=REGISTRATION&action=DELETED&id=reg-1';

/** MIT chain-root unflatten check — standingInstruction dotted path. */
export const WEBHOOK_MIT_SI =
  'id=pay-1&result.code=000.100.110' +
  '&standingInstruction.initialTransactionId=CIT-ROOT-1' +
  '&type=PAYMENT';

// ─── /v1 recurring (MIT charge) + refund — NESTED JSON responses ────

/**
 * MIT charge response (POST /v1/registrations/{id}/payments) — parsed
 * DIRECTLY as nested (not via pickField). Peach echoes the chain root
 * under standingInstruction.initialTransactionId on REPEATED responses.
 */
export const V1_MIT_CHARGE_RESPONSE = {
  id:     'pay-mit-1',
  result: { code: '000.100.110', description: 'Request successfully processed' },
  standingInstruction: { initialTransactionId: 'CIT-ROOT-1' },
};

/** Refund response (POST /v1/payments/{id}) — nested. */
export const V1_REFUND_RESPONSE = {
  id:     'refund-1',
  result: { code: '000.100.110', description: 'Request successfully processed' },
};

// ─── AWAITING LIVE CAPTURE (Phase 2) ────────────────────────────────
//
// Peach documents cardholderInitiatedTransactionId + schemeTransactionId
// on the successful CIT response/webhook as the stored-credential chain
// root. NO real captured body in the repo proves which one Peach accepts
// as standingInstruction.initialTransactionId on a subsequent MIT. Until
// a live sandbox MIT is captured (Phase 2), the fields below are the
// DOCUMENTED shape only — the tests that assert them are skipped and
// marked "AWAITING LIVE CAPTURE".
export const V2_STATUS_DOC_SCHEME_IDS: Record<string, unknown> = {
  'result.code':                    '000.100.110',
  id:                                'pay-scheme',
  merchantTransactionId:             'bncschemeidsxx',
  amount:                            '92.00',
  registrationId:                    'reg-scheme',
  cardholderInitiatedTransactionId:  'CIT-XREF-DOC',
  schemeTransactionId:               'SCHEME-XREF-DOC',
};
