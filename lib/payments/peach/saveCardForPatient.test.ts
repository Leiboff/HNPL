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
