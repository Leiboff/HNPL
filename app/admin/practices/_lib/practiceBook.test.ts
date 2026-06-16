import { describe, it, expect } from 'vitest';
import {
  classifyBookHealth,
  sumPayouts,
  MIN_SAMPLE_SIZE,
  FOCUS_RATE_BELOW,
  WATCH_RATE_BELOW,
  type PayoutRow,
} from './practiceBook';
import { type Reliability } from '../../customers/_lib/reliability';

// ─── Practice book-health classifier — pin the bands ──────────────────────
//
// Operator-facing semantics:
//   • below FOCUS  → red 'focus-area'   (this practice's book is bad)
//   • below WATCH  → amber 'watch'      (early warning)
//   • else         → green 'healthy'
//   • insufficient-data short-circuits when there isn't enough sample
//   • any written-off salary-date installment is a hard focus-area

// Synthetic Reliability rows — we only fill the fields the classifier
// reads so the test stays focused.
function rel(opts: Partial<Reliability>): Reliability {
  return {
    total_financed:                  opts.total_financed                  ?? 0,
    total_collected:                 opts.total_collected                 ?? 0,
    total_outstanding:               opts.total_outstanding               ?? 0,
    outstanding_on_track:            opts.outstanding_on_track            ?? 0,
    outstanding_at_risk:             opts.outstanding_at_risk             ?? 0,
    reliability_rate:                opts.reliability_rate                ?? null,
    salary_date_due_count:           opts.salary_date_due_count           ?? 0,
    salary_date_on_time_count:       opts.salary_date_on_time_count       ?? 0,
    salary_date_failed_count:        opts.salary_date_failed_count        ?? 0,
    salary_date_written_off_count:   opts.salary_date_written_off_count   ?? 0,
    has_overdue:                     opts.has_overdue                     ?? false,
    has_written_off:                 opts.has_written_off                 ?? false,
    standing:                        opts.standing                        ?? 'good-standing',
  };
}

describe('classifyBookHealth — band thresholds', () => {
  it('exports the documented threshold constants', () => {
    expect(MIN_SAMPLE_SIZE).toBe(3);
    expect(FOCUS_RATE_BELOW).toBe(0.70);
    expect(WATCH_RATE_BELOW).toBe(0.85);
  });

  it("rate >= 0.85 with enough sample → 'healthy'", () => {
    const out = classifyBookHealth(rel({
      reliability_rate:      0.90,
      salary_date_due_count: 10,
    }));
    expect(out).toBe('healthy');
  });

  it("0.70 <= rate < 0.85 → 'watch'", () => {
    const out = classifyBookHealth(rel({
      reliability_rate:      0.80,
      salary_date_due_count: 10,
    }));
    expect(out).toBe('watch');
  });

  it("rate < 0.70 → 'focus-area'", () => {
    const out = classifyBookHealth(rel({
      reliability_rate:      0.50,
      salary_date_due_count: 10,
    }));
    expect(out).toBe('focus-area');
  });

  it("exactly 0.85 → 'healthy' (>= is the boundary)", () => {
    const out = classifyBookHealth(rel({
      reliability_rate:      0.85,
      salary_date_due_count: 10,
    }));
    expect(out).toBe('healthy');
  });

  it("exactly 0.70 → 'watch' (>= is the boundary)", () => {
    const out = classifyBookHealth(rel({
      reliability_rate:      0.70,
      salary_date_due_count: 10,
    }));
    expect(out).toBe('watch');
  });
});

describe('classifyBookHealth — sample-size guard', () => {
  it("returns 'insufficient-data' when the sample is below the minimum", () => {
    const out = classifyBookHealth(rel({
      reliability_rate:      1.0,
      salary_date_due_count: 2,
    }));
    expect(out).toBe('insufficient-data');
  });

  it("returns 'insufficient-data' when reliability_rate is null", () => {
    const out = classifyBookHealth(rel({
      reliability_rate:      null,
      salary_date_due_count: 0,
    }));
    expect(out).toBe('insufficient-data');
  });
});

describe('classifyBookHealth — hard write-off override', () => {
  it("any salary-date written-off → 'focus-area' regardless of rate", () => {
    const out = classifyBookHealth(rel({
      reliability_rate:                0.95,
      salary_date_due_count:           20,
      salary_date_written_off_count:   1,
    }));
    expect(out).toBe('focus-area');
  });

  it("write-off override also bypasses insufficient-data", () => {
    // A practice with just 1 attempt that ended in write-off is
    // explicitly flagged — that's what the override is for.
    const out = classifyBookHealth(rel({
      reliability_rate:                0,
      salary_date_due_count:           1,
      salary_date_written_off_count:   1,
    }));
    expect(out).toBe('focus-area');
  });
});

describe('sumPayouts — fee, paid, pending', () => {
  function payout(o: Partial<PayoutRow> & { status: string }): PayoutRow {
    return {
      gross_amount: o.gross_amount ?? 1000,
      fee_amount:   o.fee_amount   ??   60,
      net_amount:   o.net_amount   ??  940,
      status:       o.status,
    };
  }

  it('sums fee_amount across all non-failed payouts (BetterNow MDR revenue)', () => {
    const out = sumPayouts([
      payout({ status: 'paid',       fee_amount: 60 }),
      payout({ status: 'pending',    fee_amount: 60 }),
      payout({ status: 'processing', fee_amount: 60 }),
    ]);
    expect(out.fees_earned).toBe(180);
  });

  it('excludes failed payouts from fees_earned — failed = cash never moved', () => {
    const out = sumPayouts([
      payout({ status: 'paid',   fee_amount: 60 }),
      payout({ status: 'failed', fee_amount: 60 }),
    ]);
    expect(out.fees_earned).toBe(60);
  });

  it("paid_out sums net_amount of 'paid' rows only", () => {
    const out = sumPayouts([
      payout({ status: 'paid',    net_amount: 940 }),
      payout({ status: 'paid',    net_amount: 470 }),
      payout({ status: 'pending', net_amount: 999 }),
    ]);
    expect(out.paid_out).toBe(1410);
    expect(out.paid_count).toBe(2);
  });

  it("pending_out sums net_amount of 'pending' + 'processing' rows", () => {
    const out = sumPayouts([
      payout({ status: 'pending',    net_amount: 500 }),
      payout({ status: 'processing', net_amount: 300 }),
      payout({ status: 'paid',       net_amount: 100 }),
    ]);
    expect(out.pending_out).toBe(800);
    expect(out.pending_count).toBe(2);
  });

  it('handles numeric string amounts (Postgres NUMERIC)', () => {
    const out = sumPayouts([
      { status: 'paid', gross_amount: '1000.50', fee_amount: '60.03', net_amount: '940.47' },
    ]);
    expect(out.fees_earned).toBe(60.03);
    expect(out.paid_out).toBe(940.47);
  });

  it('returns zeros for an empty input', () => {
    const out = sumPayouts([]);
    expect(out).toEqual({
      fees_earned: 0, paid_out: 0, pending_out: 0, paid_count: 0, pending_count: 0,
    });
  });
});
