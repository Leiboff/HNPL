import { describe, it, expect } from 'vitest';
import {
  TERMS_VERSION,
  TERMS_EFFECTIVE_DATE,
  TERMS_EFFECTIVE_DATE_LABEL,
} from './terms';

// ─── Legal terms constants ──────────────────────────────────────────────
//
// These are the single source of truth referenced by the /legal/terms
// page AND the acceptance-recording writes (signup + plan activation).
// Pinning them here means a bump is a deliberate, reviewed change.

describe('terms constants', () => {
  it('current version is 1.0', () => {
    expect(TERMS_VERSION).toBe('1.0');
  });

  it('effective date is 2026-08-03 (ISO) with a matching human label', () => {
    expect(TERMS_EFFECTIVE_DATE).toBe('2026-08-03');
    expect(TERMS_EFFECTIVE_DATE_LABEL).toBe('3 August 2026');
  });

  it('the ISO date and the label denote the same day', () => {
    // Guard against the two drifting apart on a future bump.
    const [y, m, d] = TERMS_EFFECTIVE_DATE.split('-').map(Number);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    expect(TERMS_EFFECTIVE_DATE_LABEL).toBe(`${d} ${months[m - 1]} ${y}`);
  });
});
