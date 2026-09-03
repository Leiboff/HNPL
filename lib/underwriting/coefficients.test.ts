import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  COEFFICIENTS,
  COEFFICIENT_VERSION,
  STALENESS_MONTHS,
  DECLINE_COOLDOWN_MONTHS,
  BAND_CEILINGS,
} from './coefficients';

// ─── The version bump is enforced, not remembered ───────────────────────
//
// `credit_assessments.coefficient_version` is what makes the calibration
// data usable: it says which numbers priced a given limit. That guarantee
// is worth nothing if someone edits a coefficient and leaves the version
// alone, because two different pricings then share one label and the
// cohort analysis is silently wrong.
//
// So the values are digested and the digest is pinned here. Change any
// coefficient and this test fails with a message telling you to bump the
// version and update the digest — a deliberate two-step, which is the
// point.

/** Digest of every pricing coefficient, excluding the version label itself. */
function digestCoefficients(): string {
  const { version: _version, ...priced } = COEFFICIENTS;
  return createHash('sha256').update(JSON.stringify(priced)).digest('hex').slice(0, 16);
}

describe('coefficient provenance', () => {
  it('the pinned digest matches the current values', () => {
    expect(
      digestCoefficients(),
      'Coefficients changed. Bump COEFFICIENT_VERSION and update this digest '
      + 'in the same commit, so calibration data can tell the two pricings apart.',
    ).toBe('fb26082fda6686bb');
  });

  it('the version is the one those values are labelled with', () => {
    expect(COEFFICIENT_VERSION).toBe('2026.27-r1');
    expect(COEFFICIENTS.version).toBe(COEFFICIENT_VERSION);
  });

  it('the version names a tax year, so a table change forces a new label', () => {
    expect(COEFFICIENT_VERSION).toMatch(/^\d{4}\.\d{2}-r\d+$/);
  });
});

// ─── Operational windows are env-driven, not pricing ────────────────────
//
// Deliberately outside the digest: shortening the staleness window in UAT
// does not change how a limit is priced, and should not invalidate the
// coefficient label on rows already written.

describe('lifecycle windows', () => {
  it('default to six months stale and three months cooldown', () => {
    // No env override set in the test environment.
    expect(STALENESS_MONTHS).toBe(6);
    expect(DECLINE_COOLDOWN_MONTHS).toBe(3);
  });

  it('are excluded from the coefficient digest', () => {
    expect(Object.keys(COEFFICIENTS)).not.toContain('stalenessMonths');
    expect(Object.keys(COEFFICIENTS)).not.toContain('declineCooldownMonths');
  });
});

describe('band ceilings are internally coherent', () => {
  it('ascend with improving risk', () => {
    expect(BAND_CEILINGS.thin_file!).toBeLessThan(BAND_CEILINGS.average!);
    expect(BAND_CEILINGS.average!).toBeLessThan(BAND_CEILINGS.low!);
    expect(BAND_CEILINGS.low!).toBeLessThan(BAND_CEILINGS.minimum!);
  });

  it('declining bands carry null, not zero', () => {
    // Zero would price a limit of nothing; null is a refusal, which is a
    // different row in the log and different copy for the patient.
    expect(BAND_CEILINGS.high).toBeNull();
    expect(BAND_CEILINGS.very_high).toBeNull();
  });

  it('no approvable ceiling sits below the minimum limit', () => {
    for (const [band, ceiling] of Object.entries(BAND_CEILINGS)) {
      if (ceiling === null) continue;
      expect(ceiling, `${band} ceiling`).toBeGreaterThanOrEqual(COEFFICIENTS.minimumLimit);
    }
  });
});
