import { describe, it, expect } from 'vitest';
import {
  PRIVACY_VERSION,
  PRIVACY_EFFECTIVE_DATE,
  PRIVACY_EFFECTIVE_DATE_LABEL,
} from './privacy';

// ─── Privacy Policy constants ───────────────────────────────────────────
//
// Single source of truth referenced by the /legal/privacy page AND the
// acceptance-recording writes (profiles/plans.privacy_version). Mirror of
// lib/legal/terms.test.ts.

describe('privacy constants', () => {
  it('current version is 1.0', () => {
    expect(PRIVACY_VERSION).toBe('1.0');
  });

  it('effective date is 2026-08-03 (ISO) with a matching human label', () => {
    expect(PRIVACY_EFFECTIVE_DATE).toBe('2026-08-03');
    expect(PRIVACY_EFFECTIVE_DATE_LABEL).toBe('3 August 2026');
  });

  it('the ISO date and the label denote the same day', () => {
    const [y, m, d] = PRIVACY_EFFECTIVE_DATE.split('-').map(Number);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    expect(PRIVACY_EFFECTIVE_DATE_LABEL).toBe(`${d} ${months[m - 1]} ${y}`);
  });
});
