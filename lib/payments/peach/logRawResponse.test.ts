import { describe, it, expect } from 'vitest';
import { redactCardData } from './logRawResponse';
import {
  V2_STATUS_FLAT_0EA3,
  V2_STATUS_DOC_SCHEME_IDS,
  V1_MIT_CHARGE_RESPONSE,
} from './__fixtures__/capturedBodies';

// ─── Card-redaction for the Phase-2 chain-root capture logging ──────
//
// The capture logs raw Peach bodies to diagnose which field roots the
// stored-credential chain. The redaction must:
//   • strip the card fingerprint (last4/bin/holder/expiry) — never log it,
//   • KEEP every transaction-id field, ESPECIALLY the ones we're hunting
//     (cardholderInitiatedTransactionId, schemeTransactionId, id,
//      standingInstruction.initialTransactionId, registrationId).
// A substring-based redactor would wrongly strip
// "cardHolderInitiatedTransactionId" (contains "holder") — this suite
// pins the exact-leaf behaviour that prevents that.

describe('redactCardData — keeps ids, strips the card fingerprint', () => {
  it('KEEPS cardholderInitiatedTransactionId + schemeTransactionId (the capture targets)', () => {
    const out = redactCardData(V2_STATUS_DOC_SCHEME_IDS) as Record<string, unknown>;
    expect(out.cardholderInitiatedTransactionId).toBe('CIT-XREF-DOC');
    expect(out.schemeTransactionId).toBe('SCHEME-XREF-DOC');
    expect(out.id).toBe('pay-scheme');
    expect(out.registrationId).toBe('reg-scheme');
    expect(out.merchantTransactionId).toBe('bncschemeidsxx');
  });

  it('redacts flat dotted card leaves, keeps result/id/registrationId (real flat body)', () => {
    const out = redactCardData(V2_STATUS_FLAT_0EA3) as Record<string, unknown>;
    expect(out['card.last4Digits']).toBe('[redacted]');
    expect(out['card.bin']).toBe('[redacted]');
    expect(out['card.holder']).toBe('[redacted]');
    expect(out['card.expiryMonth']).toBe('[redacted]');
    expect(out['card.expiryYear']).toBe('[redacted]');
    // Non-card fields survive.
    expect(out['result.code']).toBe('000.100.110');
    expect(out.id).toBe('pay-flat-0ea3');
    expect(out.registrationId).toBe('8ac7a49f9fb7fec7019fbf26b73e7852');
    // paymentBrand is not a fingerprint leaf — kept.
    expect(out['card.paymentBrand']).toBe('VISA');
  });

  it('redacts NESTED card leaves too, keeps standingInstruction echo', () => {
    const out = redactCardData({
      id: 'pay-mit',
      card: { last4Digits: '0042', bin: '400000', holder: 'A B', expiryMonth: '12', expiryYear: '2030', paymentBrand: 'VISA' },
      standingInstruction: { initialTransactionId: 'CIT-ROOT-1' },
    }) as { card: Record<string, unknown>; standingInstruction: Record<string, unknown>; id: string };
    expect(out.card.last4Digits).toBe('[redacted]');
    expect(out.card.holder).toBe('[redacted]');
    expect(out.card.paymentBrand).toBe('VISA');
    expect(out.standingInstruction.initialTransactionId).toBe('CIT-ROOT-1');
    expect(out.id).toBe('pay-mit');
  });

  it('the MIT response echo survives redaction (nothing to strip)', () => {
    const out = redactCardData(V1_MIT_CHARGE_RESPONSE) as { standingInstruction: { initialTransactionId: string } };
    expect(out.standingInstruction.initialTransactionId).toBe('CIT-ROOT-1');
  });

  it('is null/primitive safe', () => {
    expect(redactCardData(null)).toBeNull();
    expect(redactCardData('x')).toBe('x');
    expect(redactCardData(undefined)).toBeUndefined();
  });
});
