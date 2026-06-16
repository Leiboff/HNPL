import { describe, it, expect } from 'vitest';
import { sumPayouts, type PayoutRow } from './practiceBook';

// ─── Practice payout aggregation — keep the fee math honest ────────────────
//
// Book-health bands have moved to app/admin/_lib/standing.test.ts.
// What lives here is purely the per-practice payout totals.

function payout(o: Partial<PayoutRow> & { status: string }): PayoutRow {
  return {
    gross_amount: o.gross_amount ?? 1000,
    fee_amount:   o.fee_amount   ??   60,
    net_amount:   o.net_amount   ??  940,
    status:       o.status,
  };
}

describe('sumPayouts — fee, paid, pending', () => {
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
