import { describe, it, expect } from 'vitest';
import { fingerprintForCard, chooseCardSaveAction } from './saveCardForPatient';

// Pure-function tests only. The DB path is exercised behaviourally by
// the webhook tests where a real Supabase mock is worthwhile.

describe('fingerprintForCard — stable synthetic fingerprint', () => {
  it('brand + last4 + expiry produce a stable string', () => {
    const fp = fingerprintForCard({ brand: 'VISA', last4: '4242', expiryMonth: 12, expiryYear: 2030 });
    expect(fp).toBe('peach:VISA:4242:122030');
  });
  it('brand case is normalised', () => {
    expect(fingerprintForCard({ brand: 'visa', last4: '4242', expiryMonth: 12, expiryYear: 2030 }))
      .toBe(fingerprintForCard({ brand: 'VISA', last4: '4242', expiryMonth: 12, expiryYear: 2030 }));
  });
  it('bad inputs return null (skips dedup)', () => {
    expect(fingerprintForCard({ brand: null, last4: '4242', expiryMonth: 12, expiryYear: 2030 })).toBeNull();
    expect(fingerprintForCard({ brand: 'VISA', last4: '424', expiryMonth: 12, expiryYear: 2030 })).toBeNull();
    expect(fingerprintForCard({ brand: 'VISA', last4: '4242', expiryMonth: 13, expiryYear: 2030 })).toBeNull();
    expect(fingerprintForCard({ brand: 'VISA', last4: '4242', expiryMonth: 12, expiryYear: 1990 })).toBeNull();
  });
});

// ─── Regression: a real brand must yield a NON-null signature ───────
//
// The V2 brand-read bug fed brand="Card"/null into fingerprintForCard,
// which returns null → every saved card had signature NULL → the
// (patient_id, signature) dedup index never engaged. With the brand
// read fixed (top-level paymentBrand → 'VISA'), the SAME card yields a
// stable non-null fingerprint, so dedup works again.
describe('fingerprintForCard — the brand fix restores a non-null signature', () => {
  it('the exact evidence card (VISA 0042 02/2031) now fingerprints non-null', () => {
    const fp = fingerprintForCard({ brand: 'VISA', last4: '0042', expiryMonth: 2, expiryYear: 2031 });
    expect(fp).toBe('peach:VISA:0042:022031');
    expect(fp).not.toBeNull();
  });

  it('the OLD broken brand ("Card"/null) is why signature was NULL', () => {
    // "Card" is a valid non-empty brand string, so it DOES fingerprint —
    // but the real regression fed null (brand absent) → null signature.
    expect(fingerprintForCard({ brand: null, last4: '0042', expiryMonth: 2, expiryYear: 2031 })).toBeNull();
  });

  it('same physical card → identical fingerprint (dedup key is stable)', () => {
    const a = fingerprintForCard({ brand: 'VISA', last4: '0042', expiryMonth: 2, expiryYear: 2031 });
    const b = fingerprintForCard({ brand: 'visa', last4: '0042', expiryMonth: 2, expiryYear: 2031 });
    expect(a).toBe(b);
  });

  it('a DIFFERENT card → different fingerprint (distinct row)', () => {
    const a = fingerprintForCard({ brand: 'VISA',       last4: '0042', expiryMonth: 2, expiryYear: 2031 });
    const b = fingerprintForCard({ brand: 'MASTERCARD', last4: '1111', expiryMonth: 2, expiryYear: 2031 });
    expect(a).not.toBe(b);
  });
});

describe('dedup decision once a real signature exists (same card updates, new card inserts)', () => {
  const REG_OLD = 'reg-old', REG_NEW = 'reg-new';
  it('same card, same token → already_saved (no-op)', () => {
    expect(chooseCardSaveAction({ id: 'c1', token: REG_OLD }, false, REG_OLD))
      .toEqual({ action: 'already_saved', cardId: 'c1' });
  });
  it('same card fingerprint, NEW token → update in place (token refresh)', () => {
    expect(chooseCardSaveAction({ id: 'c1', token: REG_OLD }, false, REG_NEW))
      .toEqual({ action: 'update', cardId: 'c1' });
  });
  it('different card (no fingerprint match → existing null) → insert new row', () => {
    expect(chooseCardSaveAction(null, false, REG_NEW))
      .toEqual({ action: 'insert', isFirst: false });
  });
});

describe('chooseCardSaveAction — insert/update/already_saved', () => {
  it('no existing → insert (isFirst passed through)', () => {
    expect(chooseCardSaveAction(null, true, 'REG')).toEqual({ action: 'insert', isFirst: true });
    expect(chooseCardSaveAction(null, false, 'REG')).toEqual({ action: 'insert', isFirst: false });
  });
  it('existing with matching token → already_saved', () => {
    expect(chooseCardSaveAction({ id: 'c1', token: 'REG' }, false, 'REG'))
      .toEqual({ action: 'already_saved', cardId: 'c1' });
  });
  it('existing with different token → update (token refresh)', () => {
    expect(chooseCardSaveAction({ id: 'c1', token: 'OLD' }, false, 'NEW'))
      .toEqual({ action: 'update', cardId: 'c1' });
  });
});
