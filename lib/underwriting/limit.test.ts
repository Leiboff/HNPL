import { describe, it, expect } from 'vitest';
import {
  calculateCreditLimit,
  predictedGross,
  declaredGross,
  resolveIncomeBasis,
  roundDownToStep,
  type GmipPrediction,
  type LimitInput,
  type PredictedGross,
} from './limit';
import { BAND_CEILINGS, MINIMUM_LIMIT } from './coefficients';

// A High-confidence prediction with sane expense figures. Individual tests
// override only the field under examination.
function prediction(over: Partial<GmipPrediction> = {}): GmipPrediction {
  return {
    gross: predictedGross(30_000),
    confidence: 'High',
    bureauExpenses: 2_000,
    calcLivingExpenses: 6_000,
    ...over,
  };
}

function input(over: Partial<LimitInput> = {}): LimitInput {
  return { band: 'low', prediction: prediction(), declared: null, ...over };
}

// ─── Declared income ────────────────────────────────────────────────────

describe('declared income can lower a limit and never raise one', () => {
  it('is ignored when it is above the prediction', () => {
    const without = calculateCreditLimit(input());
    const above   = calculateCreditLimit(input({ declared: declaredGross(90_000) }));
    expect(above).toEqual(without);
  });

  it('replaces the prediction when it is below it', () => {
    const result = calculateCreditLimit(input({ declared: declaredGross(12_000) }));
    expect(result.workings.incomeBasis).toBe(12_000);
    expect(result.workings.declaredLoweredBasis).toBe(true);
  });

  it('a lower declared figure never produces a higher limit', () => {
    const base = calculateCreditLimit(input());
    for (const declared of [5_000, 12_000, 20_000, 29_999]) {
      const lowered = calculateCreditLimit(input({ declared: declaredGross(declared) }));
      const baseLimit    = base.decision    === 'approved' ? base.limit    : 0;
      const loweredLimit = lowered.decision === 'approved' ? lowered.limit : 0;
      expect(loweredLimit).toBeLessThanOrEqual(baseLimit);
    }
  });

  it('resolveIncomeBasis is a plain min, in both directions', () => {
    expect(resolveIncomeBasis(predictedGross(30_000), declaredGross(12_000))).toBe(12_000);
    expect(resolveIncomeBasis(predictedGross(30_000), declaredGross(50_000))).toBe(30_000);
    expect(resolveIncomeBasis(predictedGross(30_000), null)).toBe(30_000);
    expect(resolveIncomeBasis(null, declaredGross(9_000))).toBe(9_000);
    expect(resolveIncomeBasis(null, null)).toBeNull();
  });

  it('the two income types are not interchangeable at compile time', () => {
    // If DeclaredGross ever became assignable to PredictedGross this
    // directive would be unused and `pnpm typecheck` would fail — which is
    // the structural guarantee the money path depends on.
    // @ts-expect-error a declared figure must never stand in for a prediction
    const wrong: PredictedGross = declaredGross(5_000);
    expect(wrong).toBe(5_000);
  });

  it('rejects nonsense at the constructors rather than downstream', () => {
    expect(() => predictedGross(0)).toThrow(RangeError);
    expect(() => predictedGross(-1)).toThrow(RangeError);
    expect(() => declaredGross(NaN)).toThrow(RangeError);
  });
});

// ─── The living-expense floor, both directions ──────────────────────────

describe('living expenses take the greater of the bureau norm and 25% of net', () => {
  it('the bureau norm wins when it exceeds the floor', () => {
    const result = calculateCreditLimit(input({
      prediction: prediction({ gross: predictedGross(12_000), calcLivingExpenses: 4_000 }),
    }));
    // net is 11,205, so the 25% floor is 2,801.25 — the R4,000 norm wins.
    expect(result.workings.livingSource).toBe('bureau_norm');
    expect(result.workings.living).toBeCloseTo(4_000, 6);
  });

  it('the 25%-of-net floor wins when the bureau norm is implausibly low', () => {
    const result = calculateCreditLimit(input({
      prediction: prediction({ calcLivingExpenses: 100 }),
    }));
    expect(result.workings.livingSource).toBe('net_floor');
    expect(result.workings.living).toBeCloseTo(result.workings.net!.monthlyNet * 0.25, 6);
  });

  it('a zero bureau norm cannot produce a limit as if the patient has no costs', () => {
    const withZero  = calculateCreditLimit(input({ prediction: prediction({ calcLivingExpenses: 0 }) }));
    const withFloor = calculateCreditLimit(input({ prediction: prediction({ calcLivingExpenses: 6_000 }) }));
    // Both land on the floor or above it; neither treats net as fully disposable.
    expect(withZero.workings.living).toBeGreaterThan(0);
    expect(withZero.workings.ndi!).toBeLessThan(withZero.workings.net!.monthlyNet);
    expect(withFloor.workings.living).toBeGreaterThan(0);
  });
});

// ─── The Medium haircut ─────────────────────────────────────────────────

describe('the Medium-confidence haircut', () => {
  const lowIncome = () => prediction({ gross: predictedGross(12_000), calcLivingExpenses: 4_000, bureauExpenses: 1_500 });

  it('reduces the monthly figure to 85% and is recorded', () => {
    const high   = calculateCreditLimit(input({ prediction: { ...lowIncome(), confidence: 'High' } }));
    const medium = calculateCreditLimit(input({ prediction: { ...lowIncome(), confidence: 'Medium' } }));

    expect(high.workings.haircutApplied).toBe(false);
    expect(medium.workings.haircutApplied).toBe(true);
    expect(medium.workings.monthly!).toBeCloseTo(high.workings.monthly! * 0.85, 6);
  });

  it('High confidence takes no haircut at all', () => {
    const high = calculateCreditLimit(input({ prediction: { ...lowIncome(), confidence: 'High' } }));
    expect(high.workings.monthly!).toBeCloseTo(high.workings.ndi! * 0.20, 6);
  });
});

// ─── Each ceiling ───────────────────────────────────────────────────────

describe('each band ceiling binds when the formula would exceed it', () => {
  // A high earner whose formula result clears every ceiling.
  const rich = () => prediction({
    gross: predictedGross(50_000), calcLivingExpenses: 5_000, bureauExpenses: 2_000,
  });

  it.each([
    ['minimum', 15_000],
    ['low',     10_000],
    ['average',  3_000],
  ] as const)('%s risk caps at R%i', (band, ceiling) => {
    const result = calculateCreditLimit(input({ band, prediction: rich() }));
    expect(result.decision).toBe('approved');
    expect(result.decision === 'approved' && result.limit).toBe(ceiling);
    expect(result.binding).toBe('band_ceiling');
    expect(result.workings.facility!).toBeGreaterThan(ceiling);
  });

  it('the ceilings match the published table', () => {
    expect(BAND_CEILINGS.minimum).toBe(15_000);
    expect(BAND_CEILINGS.low).toBe(10_000);
    expect(BAND_CEILINGS.average).toBe(3_000);
    expect(BAND_CEILINGS.thin_file).toBe(1_000);
    expect(BAND_CEILINGS.high).toBeNull();
    expect(BAND_CEILINGS.very_high).toBeNull();
  });
});

describe('a declining band refuses even if it somehow reaches the calculation', () => {
  it.each(['high', 'very_high'] as const)('%s risk declines rather than pricing', (band) => {
    const result = calculateCreditLimit(input({ band, prediction: prediction() }));
    expect(result.decision).toBe('declined');
    expect(result.decision === 'declined' && result.reason).toBe('band');
    // Emphatically not a zero limit — a different outcome entirely.
    expect(result).not.toHaveProperty('limit');
  });
});

// ─── The formula binding, and the cap that cannot ───────────────────────

describe('the affordability formula binds below the ceiling', () => {
  it('a modest earner is priced by the formula, not the band', () => {
    const result = calculateCreditLimit(input({
      prediction: prediction({ gross: predictedGross(12_000), calcLivingExpenses: 4_000, bureauExpenses: 1_500 }),
    }));
    // net 11,205 − 1,500 − 4,000 = 5,705 NDI → 1,141/mo → 3,423 facility.
    expect(result.workings.ndi!).toBeCloseTo(5_705, 6);
    expect(result.workings.facility!).toBeCloseTo(3_423, 6);
    expect(result.binding).toBe('formula');
    expect(result.decision === 'approved' && result.limit).toBe(3_000);
  });
});

describe('the income cap', () => {
  it('cannot bind while a prediction exists — the facility is at most 60% of gross', () => {
    // facility = NDI × 0.20 × 3 = 0.6 × NDI, and NDI < net < gross. So
    // min(facility, ceiling, gross) can never select gross. Documented as a
    // test because it means the GMIP cap is inert on this path under the
    // current coefficients; change FACILITY_MONTHS or the ratio and this
    // fails, which is the point.
    for (const gross of [6_000, 12_000, 30_000, 50_000, 120_000]) {
      const result = calculateCreditLimit(input({
        band: 'minimum',
        prediction: prediction({ gross: predictedGross(gross), calcLivingExpenses: 0, bureauExpenses: 0 }),
      }));
      expect(result.workings.facility!).toBeLessThan(gross);
      expect(result.binding).not.toBe('income_cap');
    }
  });

  it('does bind on the thin-file path, where there is no facility to lose to', () => {
    const result = calculateCreditLimit({
      band: 'thin_file', prediction: null, declared: declaredGross(800),
    });
    // min(1,000 ceiling, 800 declared) = 800 → rounds to 500 → under the floor.
    expect(result.decision).toBe('declined');
    expect(result.decision === 'declined' && result.reason).toBe('below_minimum');
  });
});

// ─── Rounding ───────────────────────────────────────────────────────────

describe('limits round DOWN to the nearest 500', () => {
  it.each([
    [3_423, 3_000],
    [3_000, 3_000],
    [3_499, 3_000],
    [3_500, 3_500],
    [999,     500],
    [10_113, 10_000],
  ])('%i rounds to %i', (raw, expected) => {
    expect(roundDownToStep(raw)).toBe(expected);
  });

  it('never rounds up — that would lend money the formula did not justify', () => {
    for (let v = 1_000; v < 4_000; v += 37) {
      expect(roundDownToStep(v)).toBeLessThanOrEqual(v);
    }
  });

  it('handles zero and negatives without producing a negative limit', () => {
    expect(roundDownToStep(0)).toBe(0);
    expect(roundDownToStep(-500)).toBe(0);
  });
});

// ─── The R1,000 floor ───────────────────────────────────────────────────

describe('a rounded limit below R1,000 declines', () => {
  it('a low earner with heavy obligations is declined, not granted R500', () => {
    const result = calculateCreditLimit(input({
      prediction: prediction({
        gross: predictedGross(5_000), calcLivingExpenses: 2_000, bureauExpenses: 2_000,
      }),
    }));
    // net 4,950 − 2,000 − 2,000 = 950 NDI → 190/mo → 570 → rounds to 500.
    expect(result.workings.facility!).toBeCloseTo(570, 6);
    expect(result.decision).toBe('declined');
    expect(result.decision === 'declined' && result.reason).toBe('below_minimum');
    expect(result.binding).toBe('minimum');
  });

  it('exactly R1,000 is approved — the floor is inclusive', () => {
    const result = calculateCreditLimit({
      band: 'thin_file', prediction: null, declared: null,
    });
    expect(result.decision).toBe('approved');
    expect(result.decision === 'approved' && result.limit).toBe(MINIMUM_LIMIT);
  });

  it('negative NDI cannot produce a negative limit', () => {
    const result = calculateCreditLimit(input({
      prediction: prediction({
        gross: predictedGross(6_000), calcLivingExpenses: 5_000, bureauExpenses: 5_000,
      }),
    }));
    expect(result.workings.ndi!).toBeLessThan(0);
    expect(result.workings.facility!).toBe(0);
    expect(result.decision).toBe('declined');
  });
});

// ─── Thin file ──────────────────────────────────────────────────────────

describe('the thin-file path is a grant, not an error', () => {
  it('a null prediction lands on the thin-file ceiling', () => {
    const result = calculateCreditLimit({ band: 'thin_file', prediction: null, declared: null });
    expect(result.decision).toBe('approved');
    expect(result.decision === 'approved' && result.limit).toBe(1_000);
    expect(result.binding).toBe('band_ceiling');
    expect(result.workings.net).toBeNull();
    expect(result.workings.facility).toBeNull();
  });

  it('a declared figure above the ceiling does not raise it', () => {
    const result = calculateCreditLimit({
      band: 'thin_file', prediction: null, declared: declaredGross(40_000),
    });
    expect(result.decision === 'approved' && result.limit).toBe(1_000);
  });
});

// ─── Provenance ─────────────────────────────────────────────────────────

describe('every outcome carries its coefficient version', () => {
  it('on approvals and on declines alike', () => {
    const approved = calculateCreditLimit(input());
    const declined = calculateCreditLimit(input({ band: 'very_high' }));
    expect(approved.workings.coefficientVersion).toMatch(/^\d{4}\.\d{2}-r\d+$/);
    expect(declined.workings.coefficientVersion).toBe(approved.workings.coefficientVersion);
  });
});

// ─── The Sigma Transcend cap ────────────────────────────────────────────
//
// Transcend scores people the traditional cards cannot, so reading it
// serves applicants who would otherwise be declined outright. But a Low
// Risk on the thin-file card is not the evidence a Low Risk on the
// unsecured-credit card is, and must not buy the same exposure.

describe('a scorecard cap applies on top of the band ceiling', () => {
  const rich = () => prediction({
    gross: predictedGross(50_000), calcLivingExpenses: 5_000, bureauExpenses: 2_000,
  });

  it('STS caps at R1,000 even on Low Risk', () => {
    // The captured UAT applicant: unscorable on SU, 620 on STS = Low Risk.
    // The band ceiling says R10,000; the card says R1,000.
    const result = calculateCreditLimit(input({
      band: 'low', prediction: rich(), resultType: 'STS',
    }));

    expect(result.decision).toBe('approved');
    expect(result.decision === 'approved' && result.limit).toBe(1_000);
    expect(result.binding).toBe('scorecard_cap');
  });

  it('STS caps at R1,000 even on Minimum Risk', () => {
    const result = calculateCreditLimit(input({
      band: 'minimum', prediction: rich(), resultType: 'STS',
    }));
    expect(result.decision === 'approved' && result.limit).toBe(1_000);
    expect(result.binding).toBe('scorecard_cap');
  });

  it('SU is uncapped and keeps its band ceiling', () => {
    const result = calculateCreditLimit(input({
      band: 'low', prediction: rich(), resultType: 'SU',
    }));
    expect(result.decision === 'approved' && result.limit).toBe(10_000);
    expect(result.binding).toBe('band_ceiling');
  });

  it('an absent card behaves exactly as before', () => {
    const withNone = calculateCreditLimit(input({ band: 'low', prediction: rich() }));
    const withSu   = calculateCreditLimit(input({ band: 'low', prediction: rich(), resultType: 'SU' }));
    expect(withNone.decision === 'approved' && withNone.limit).toBe(10_000);
    expect(withSu.decision === 'approved' && withSu.limit).toBe(10_000);
  });

  it('the cap does NOT rescue a declining band', () => {
    // We take Transcend's risk signal and decline on it. We just do not
    // take the exposure when it says yes.
    for (const band of ['high', 'very_high'] as const) {
      const result = calculateCreditLimit(input({ band, prediction: rich(), resultType: 'STS' }));
      expect(result.decision, band).toBe('declined');
      expect(result.decision === 'declined' && result.reason).toBe('band');
    }
  });

  it('the formula still binds when it lands below the cap', () => {
    // A capped card does not raise anything: if affordability says less
    // than R1,000 the applicant is declined, not granted the cap.
    const result = calculateCreditLimit(input({
      band: 'low', resultType: 'STS',
      prediction: prediction({
        gross: predictedGross(5_000), calcLivingExpenses: 2_000, bureauExpenses: 2_000,
      }),
    }));
    expect(result.decision).toBe('declined');
    expect(result.decision === 'declined' && result.reason).toBe('below_minimum');
  });

  it('records the true band and the cap separately', () => {
    // The band must stay visible in the log: "how many Low-Risk Transcend
    // applicants did the cap bind on" is the number that justifies
    // keeping or relaxing it.
    const result = calculateCreditLimit(input({
      band: 'low', prediction: rich(), resultType: 'STS',
    }));
    expect(result.workings.band).toBe('low');
    expect(result.workings.bandCeiling).toBe(10_000);
    expect(result.workings.scorecardCap).toBe(1_000);
    expect(result.workings.effectiveCeiling).toBe(1_000);
    expect(result.workings.resultType).toBe('STS');
  });

  it('is case- and whitespace-insensitive on the card name', () => {
    for (const card of ['sts', ' STS ', 'Sts']) {
      const r = calculateCreditLimit(input({ band: 'low', prediction: rich(), resultType: card }));
      expect(r.decision === 'approved' && r.limit, card).toBe(1_000);
    }
  });

  it('applies on the thin-file path too, where it is a no-op', () => {
    // Both ceilings are already R1,000 there.
    const result = calculateCreditLimit({
      band: 'thin_file', prediction: null, declared: null, resultType: 'STS',
    });
    expect(result.decision === 'approved' && result.limit).toBe(1_000);
  });
});
