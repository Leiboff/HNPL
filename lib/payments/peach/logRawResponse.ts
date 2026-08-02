// SERVER-ONLY. Never import in a client component.
//
// Card-redacted logging of a raw Peach response body, for diagnostics
// and the Phase-2 live MIT chain-root capture.
//
// Redacts ONLY the card-fingerprint leaves (last4Digits, bin, holder,
// expiryMonth, expiryYear) while KEEPING every transaction-id field —
// `id`, `cardholderInitiatedTransactionId`, `schemeTransactionId`,
// `standingInstruction.initialTransactionId`, `registrationId`,
// `merchantTransactionId`, `result.code`. Those id fields are exactly
// what the chain-root capture needs to read, so the redaction is a
// precise leaf-name match (NOT a substring match — a substring match on
// "holder" would wrongly redact "cardHolderInitiatedTransactionId").
//
// Handles BOTH Peach response shapes: the FLAT dot-notation V2 status
// body ('card.last4Digits') and the nested webhook / recurring shape
// ({ card: { last4Digits } }).

const SENSITIVE_LEAVES = new Set([
  'last4digits',
  'bin',
  'holder',
  'expirymonth',
  'expiryyear',
]);

/** Deep-clone with card-fingerprint leaves replaced by '[redacted]'. */
export function redactCardData(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object') return raw;
  if (Array.isArray(raw)) return raw.map(redactCardData);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // Leaf of a flat dotted key ('card.last4Digits' → 'last4digits') or a
    // nested key ('last4Digits' → 'last4digits'). Exact-set match only.
    const leaf = (k.split('.').pop() ?? k).toLowerCase();
    if (SENSITIVE_LEAVES.has(leaf)) {
      out[k] = '[redacted]';
      continue;
    }
    out[k] = v && typeof v === 'object' ? redactCardData(v) : v;
  }
  return out;
}

/**
 * Log a raw Peach response under a greppable prefix, card data redacted.
 * Never throws — a logging call must not break a money path.
 */
export function logPeachRawResponse(prefix: string, raw: unknown): void {
  try {
    console.log(prefix, JSON.stringify(redactCardData(raw)));
  } catch {
    console.log(prefix, '[unserializable raw Peach response]');
  }
}
