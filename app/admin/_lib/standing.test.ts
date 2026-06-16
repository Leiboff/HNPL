import { describe, it, expect } from 'vitest';
import {
  computeStanding,
  verdictFor,
  STANDING_DISPLAY,
  MIN_SAMPLE_SIZE,
  AT_RISK_RATE_BELOW,
  WATCH_RATE_BELOW,
  type Standing,
} from './standing';
import { type Reliability } from '../customers/_lib/reliability';

// ─── Shared standing classifier — pin the bands + the verdict text ────────
//
// The operator's vocabulary. Customer 360 and Practice 360 BOTH go
// through this lib — these tests cover both consumers.

function rel(opts: Partial<Reliability>): Reliability {
  return {
    total_financed:                opts.total_financed                ?? 0,
    total_collected:               opts.total_collected               ?? 0,
    total_outstanding:             opts.total_outstanding             ?? 0,
    outstanding_on_track:          opts.outstanding_on_track          ?? 0,
    outstanding_at_risk:           opts.outstanding_at_risk           ?? 0,
    reliability_rate:              opts.reliability_rate              ?? null,
    salary_date_due_count:         opts.salary_date_due_count         ?? 0,
    salary_date_on_time_count:     opts.salary_date_on_time_count     ?? 0,
    salary_date_failed_count:      opts.salary_date_failed_count      ?? 0,
    salary_date_written_off_count: opts.salary_date_written_off_count ?? 0,
    has_overdue:                   opts.has_overdue                   ?? false,
    has_written_off:               opts.has_written_off               ?? false,
  };
}

describe('exported thresholds', () => {
  it('match the documented band cutoffs', () => {
    expect(MIN_SAMPLE_SIZE).toBe(3);
    expect(AT_RISK_RATE_BELOW).toBe(0.70);
    expect(WATCH_RATE_BELOW).toBe(0.85);
  });
});

describe('computeStanding — at-risk hard overrides', () => {
  it("any written-off salary-date → at-risk regardless of rate or sample", () => {
    const s = computeStanding(rel({
      reliability_rate:              1.0,
      salary_date_due_count:         20,
      salary_date_written_off_count: 1,
    }));
    expect(s).toBe('at-risk');
  });

  it("any outstanding_at_risk > 0 → at-risk regardless of rate", () => {
    const s = computeStanding(rel({
      reliability_rate:    1.0,
      salary_date_due_count: 20,
      outstanding_at_risk: 100,
    }));
    expect(s).toBe('at-risk');
  });

  it("hard overrides fire even on small samples (don't wait for stats)", () => {
    const s = computeStanding(rel({
      reliability_rate:    null,
      salary_date_due_count: 0,
      outstanding_at_risk: 500,
    }));
    expect(s).toBe('at-risk');
  });
});

describe('computeStanding — rate-based bands (with sample)', () => {
  it("rate < 0.70 with sample >= 3 → at-risk", () => {
    const s = computeStanding(rel({
      reliability_rate:      0.50,
      salary_date_due_count: 10,
    }));
    expect(s).toBe('at-risk');
  });

  it("0.70 <= rate < 0.85 → watch", () => {
    const s = computeStanding(rel({
      reliability_rate:      0.80,
      salary_date_due_count: 10,
    }));
    expect(s).toBe('watch');
  });

  it("rate >= 0.85 → healthy", () => {
    const s = computeStanding(rel({
      reliability_rate:      0.95,
      salary_date_due_count: 10,
    }));
    expect(s).toBe('healthy');
  });

  it("boundaries: exactly 0.70 → watch", () => {
    const s = computeStanding(rel({
      reliability_rate:      0.70,
      salary_date_due_count: 10,
    }));
    expect(s).toBe('watch');
  });

  it("boundaries: exactly 0.85 → healthy", () => {
    const s = computeStanding(rel({
      reliability_rate:      0.85,
      salary_date_due_count: 10,
    }));
    expect(s).toBe('healthy');
  });
});

describe('computeStanding — sample-size guard + too-new', () => {
  it("rate present but sample < 3 → too-new (don't commit on tiny sample)", () => {
    const s = computeStanding(rel({
      reliability_rate:      0.50,
      salary_date_due_count: 2,
    }));
    expect(s).toBe('too-new');
  });

  it("no salary-date attempts → too-new", () => {
    const s = computeStanding(rel({
      reliability_rate:      null,
      salary_date_due_count: 0,
    }));
    expect(s).toBe('too-new');
  });

  it("overdue with no at-risk / no write-off → watch (friction signal)", () => {
    const s = computeStanding(rel({
      reliability_rate:      null,
      salary_date_due_count: 0,
      has_overdue:           true,
    }));
    expect(s).toBe('watch');
  });
});

describe('Jacob Zuma contradiction — resolved', () => {
  // "Customer needed retries but ultimately paid, has no overdue or
  // write-offs." Old standing was 'good-standing' (= healthy) even at
  // 0% on-time. Now the rate drives the band and they read as at-risk.
  it("0% reliability with sample >= 3 reads as at-risk, NOT good-standing", () => {
    const r = rel({
      reliability_rate:      0,
      salary_date_due_count: 5,
      salary_date_on_time_count: 0,
      has_overdue:           false,
      has_written_off:       false,
      outstanding_at_risk:   0,
    });
    expect(computeStanding(r)).toBe('at-risk');
  });
});

describe('STANDING_DISPLAY config', () => {
  it('every band has a label, classes, dot, and tone', () => {
    const bands: Standing[] = ['healthy', 'watch', 'at-risk', 'too-new'];
    for (const b of bands) {
      const cfg = STANDING_DISPLAY[b];
      expect(cfg.label).toBeTruthy();
      expect(cfg.cls).toBeTruthy();
      expect(cfg.dot).toBeTruthy();
      expect(['good', 'warn', 'alert', 'default']).toContain(cfg.tone);
    }
  });

  it('vocabulary uses the agreed words (no "good standing" / "focus area")', () => {
    expect(STANDING_DISPLAY['healthy'].label).toBe('Healthy');
    expect(STANDING_DISPLAY['watch'].label).toBe('Watch');
    expect(STANDING_DISPLAY['at-risk'].label).toBe('At risk');
    expect(STANDING_DISPLAY['too-new'].label).toBe('Too new to judge');
  });
});

describe('verdictFor — practice status overrides', () => {
  it("'pending' practice → 'Awaiting approval' headline", () => {
    const out = verdictFor('too-new', rel({}), { practiceStatus: 'pending' });
    expect(out.headline).toBe('Awaiting approval');
  });

  it("'suspended' practice → 'Suspended' headline", () => {
    const out = verdictFor('healthy', rel({}), { practiceStatus: 'suspended' });
    expect(out.headline).toBe('Suspended');
  });

  it("'inactive' practice → 'Inactive' headline", () => {
    const out = verdictFor('too-new', rel({}), { practiceStatus: 'inactive' });
    expect(out.headline).toBe('Inactive');
  });
});

describe('verdictFor — dormant case (no plans)', () => {
  it("practice 'approved' with 0 plans → 'Approved · no activity yet'", () => {
    const out = verdictFor('too-new', rel({}), { plansCount: 0, practiceStatus: 'approved' });
    expect(out.headline).toBe('Approved · no activity yet');
  });

  it("customer with 0 plans → 'No plans yet'", () => {
    const out = verdictFor('too-new', rel({}), { plansCount: 0 });
    expect(out.headline).toBe('No plans yet');
  });
});

describe('verdictFor — band-specific headlines', () => {
  it("at-risk + written off → headline names the loss", () => {
    const out = verdictFor('at-risk', rel({
      salary_date_written_off_count: 2,
      outstanding_at_risk: 0,
    }), {});
    expect(out.headline).toContain('written off');
    expect(out.headline).toContain('2');
  });

  it("at-risk + at-risk-outstanding → headline names the failed count + amount", () => {
    const out = verdictFor('at-risk', rel({
      outstanding_at_risk:      3000,
      salary_date_failed_count: 2,
    }), {});
    expect(out.headline).toContain('2');
    expect(out.headline).toMatch(/failed/);
    expect(out.subline).toContain('R3,000');
  });

  it("at-risk on rate alone → headline shows the percentage", () => {
    const out = verdictFor('at-risk', rel({
      reliability_rate: 0.40,
      salary_date_due_count:     5,
      salary_date_on_time_count: 2,
    }), {});
    expect(out.headline).toContain('40%');
    expect(out.subline).toContain('2 of 5');
  });

  it("watch + overdue → mentions overdue collection", () => {
    const out = verdictFor('watch', rel({ has_overdue: true }), {});
    expect(out.headline.toLowerCase()).toContain('overdue');
  });

  it("watch on rate → headline shows the percentage", () => {
    const out = verdictFor('watch', rel({
      reliability_rate: 0.80,
      salary_date_due_count: 5,
      salary_date_on_time_count: 4,
    }), {});
    expect(out.headline).toContain('80%');
  });

  it("healthy with rate → headline 'Healthy', subline shows %", () => {
    const out = verdictFor('healthy', rel({
      reliability_rate: 0.95,
      salary_date_due_count: 20,
      salary_date_on_time_count: 19,
    }), {});
    expect(out.headline).toBe('Healthy');
    expect(out.subline).toContain('95%');
  });

  it("too-new explains what's missing", () => {
    const out = verdictFor('too-new', rel({
      salary_date_due_count: 0,
    }), { plansCount: 1 });
    expect(out.headline).toBe('Too new to judge');
    expect(out.subline?.toLowerCase()).toContain('salary-date');
  });
});
