import { describe, it, expect } from 'vitest';
import { validateSaId } from '@/lib/validation/saId';
import { VALID_SA_IDS, VALID_SA_ID, INVALID_SA_IDS } from './saIdFixtures';

// A fixture file that CLAIMS its IDs are valid is exactly the trap it exists
// to prevent, so the claims are checked rather than commented. If the
// century pivot or the citizenship rule ever changes, this fails here — in
// the fixture — instead of in whichever test borrowed from it.

describe('VALID_SA_IDS really are valid', () => {
  it.each(VALID_SA_IDS)('%s passes validateSaId', (id) => {
    expect(validateSaId(id)).toEqual({ valid: true });
  });

  it('VALID_SA_ID is one of them', () => {
    expect(VALID_SA_IDS).toContain(VALID_SA_ID);
  });

  it('they are distinct — a fixture reused as two different people is a silent test bug', () => {
    expect(new Set(VALID_SA_IDS).size).toBe(VALID_SA_IDS.length);
  });
});

describe('INVALID_SA_IDS fail for the stated reason', () => {
  it.each(INVALID_SA_IDS)('$id → $reason', ({ id, reason }) => {
    expect(validateSaId(id)).toEqual({ valid: false, reason });
  });

  it("'9001015800086' is the one that looks valid — the reason this file exists", () => {
    // Eight test files use it. All are fine, because none of them validates
    // it. This pins the fact that it WOULD fail if one ever did.
    expect(validateSaId('9001015800086')).toEqual({ valid: false, reason: 'checksum' });
    expect(/^\d{13}$/.test('9001015800086')).toBe(true);
  });
});
