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

// ─── /v1 recurring MIT charge — NESTED JSON response ────────────────

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


// ─── V2 initiate rejection — REAL capture (Phase 4) ─────────────────
//
// REAL capture (2026-08-02): the saved-card one-click initiate sent
// `allowStoredCards` on POST /v2/checkout and Peach rejected the whole
// request with HTTP 400 { "allowStoredCards": "unknown field" } — the
// initiate rolled back and the returning-patient CIT flow failed. The
// field is NOT in the current /v2/checkout reference; cardTokens alone
// is the documented one-click enabler. This fixture records the reason
// the field was removed, so a future re-add is anchored to the evidence.
export const V2_INITIATE_ALLOWSTOREDCARDS_400 = {
  allowStoredCards: 'unknown field',
};

// ─── CHAIN ROOT — RESOLVED by a live sandbox capture (Phase 2) ──────
//
// The audit's open question ("is the chain root the CIT top-level `id`,
// or the documented cardholderInitiatedTransactionId / schemeTransactionId?")
// was settled by a real sandbox MIT on 2026-08-02:
//
//   • CIT status (checkout 1dcf373f…) returned top-level
//     id = 8ac7a49f9fb7fec7019fc3fe2c097657 and carried NEITHER
//     cardholderInitiatedTransactionId NOR schemeTransactionId.
//   • We stamped that `id` as plans.peach_initial_transaction_id and sent
//     it as standingInstruction.initialTransactionId on instalment 2.
//   • The MIT was ACCEPTED — result.code 000.100.110, money moved, and
//     Peach echoed the same initialTransactionId back.
//
// Conclusion: on THIS integration the CIT top-level `id` is the ONLY
// chain root Peach returns, and it is the correct one. The scheme-id
// fields the docs mention are NOT present here — a future refactor that
// "reads the documented cardholderInitiatedTransactionId" would read
// undefined and silently break every MIT. The fixtures below pin both
// realities so that can't happen.

/**
 * REAL capture — CIT status, sandbox checkout 1dcf373f… (2026-08-02).
 * REAL captured values: top-level `id` (the chain root) + result.code +
 * the ABSENCE of cardholderInitiatedTransactionId / schemeTransactionId.
 * `merchantTransactionId` / `registrationId` / card.* are representative
 * (shape-faithful) — the tests only assert the id + the absence.
 */
export const V2_STATUS_CIT_1DCF: Record<string, unknown> = {
  'result.code':        '000.100.110',
  'result.description': "Request successfully processed in 'Merchant in Integrator Test Mode'",
  id:                    '8ac7a49f9fb7fec7019fc3fe2c097657', // ← REAL — the chain root we stamp
  merchantTransactionId: 'bnc1dcf373fcapt',                  // representative
  amount:                '92.00',
  currency:              'ZAR',
  'card.last4Digits':    '0042',                             // representative
  'card.paymentBrand':   'VISA',
  registrationId:        'reg-1dcf373f',                     // representative
  // NB: NO cardholderInitiatedTransactionId, NO schemeTransactionId —
  // confirmed absent in the real capture.
};

/**
 * REAL capture — the ACCEPTED MIT response (instalment 2) that proved
 * the chain root. REAL: result.code 000.100.110 + the echoed
 * standingInstruction.initialTransactionId === the CIT `id` we sent.
 * `id` (the MIT's own payment id) is representative.
 */
export const V1_MIT_CHARGE_ACCEPTED = {
  id:     'mit-pay-1dcf373f',                                   // representative (MIT's own id)
  result: { code: '000.100.110', description: 'Request successfully processed' },
  // Peach echoed back the initialTransactionId we sent (the CIT id).
  standingInstruction: { initialTransactionId: '8ac7a49f9fb7fec7019fc3fe2c097657' },
};

/** The exact CIT id we send as standingInstruction.initialTransactionId. */
export const CIT_CHAIN_ROOT_ID = '8ac7a49f9fb7fec7019fc3fe2c097657';

// Retained: a DOC-SHAPED synthetic body that DOES carry the scheme ids —
// used ONLY by the redaction test (proving the log redactor keeps those
// id fields IF a future Peach shape ever includes them). It is NOT
// representative of what this integration returns (see V2_STATUS_CIT_1DCF).
export const V2_STATUS_DOC_SCHEME_IDS: Record<string, unknown> = {
  'result.code':                    '000.100.110',
  id:                                'pay-scheme',
  merchantTransactionId:             'bncschemeidsxx',
  amount:                            '92.00',
  registrationId:                    'reg-scheme',
  cardholderInitiatedTransactionId:  'CIT-XREF-DOC',
  schemeTransactionId:               'SCHEME-XREF-DOC',
};
