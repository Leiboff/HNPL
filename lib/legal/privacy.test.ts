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
//
// These values moved to 1.1 / 2026-08-18 when clause 12.2's unfilled
// "[INSERT NAME / TITLE]" placeholder was replaced with a role-and-route
// identification of the Information Officer. TERMS_VERSION deliberately did
// NOT move: the T&Cs text did not change, and the two versions are
// independent columns, so they are allowed to differ.

describe('privacy constants', () => {
  it('current version is 1.1', () => {
    expect(PRIVACY_VERSION).toBe('1.1');
  });

  it('effective date is 2026-08-18 (ISO) with a matching human label', () => {
    expect(PRIVACY_EFFECTIVE_DATE).toBe('2026-08-18');
    expect(PRIVACY_EFFECTIVE_DATE_LABEL).toBe('18 August 2026');
  });

  it('has moved past 1.0 — the placeholder version is not still published', () => {
    // Guards the specific regression of reverting the bump while leaving the
    // corrected clause text in place, which would put a row stamped 1.0 back
    // to labelling text it never saw.
    expect(PRIVACY_VERSION).not.toBe('1.0');
  });

  it('the ISO date and the label denote the same day', () => {
    const [y, m, d] = PRIVACY_EFFECTIVE_DATE.split('-').map(Number);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    expect(PRIVACY_EFFECTIVE_DATE_LABEL).toBe(`${d} ${months[m - 1]} ${y}`);
  });
});
