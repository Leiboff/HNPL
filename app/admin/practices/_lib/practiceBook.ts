// ─── Practice book — payout aggregation ────────────────────────────────────
//
// The book-health classifier that used to live here has moved into the
// shared app/admin/_lib/standing.ts (computeStanding + verdictFor).
// Customer 360 and Practice 360 now share one vocabulary — practice's
// previous 'focus-area' / 'insufficient-data' labels are gone; both
// pages read from the four-band shared model (healthy / watch /
// at-risk / too-new).
//
// What's left here is the payout aggregation — purely a Practice 360
// concern. Tested in isolation in [[practiceBook-test]]:
//
//   fees_earned   — BetterNow's MDR revenue from this practice
//                   (Σ fee_amount, excluding 'failed' payouts — a
//                    failed payout means the cash never moved, so
//                    isn't realized revenue).
//   paid_out      — Σ net_amount across 'paid' payouts
//   pending_out   — Σ net_amount across 'pending' / 'processing'
//
// Plus row counts for the summary chips.

export type PayoutRow = {
  gross_amount: number | string;
  fee_amount:   number | string;
  net_amount:   number | string;
  status:       string;
};

export type PayoutTotals = {
  fees_earned:   number;
  paid_out:      number;
  pending_out:   number;
  paid_count:    number;
  pending_count: number;
};

function toNum(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

export function sumPayouts(payouts: PayoutRow[]): PayoutTotals {
  let fees_earned   = 0;
  let paid_out      = 0;
  let pending_out   = 0;
  let paid_count    = 0;
  let pending_count = 0;

  for (const p of payouts) {
    if (p.status === 'failed') {
      // A failed payout means the cash never moved — no realized fee,
      // no net out. Skip entirely.
      continue;
    }
    fees_earned += toNum(p.fee_amount);

    if (p.status === 'paid') {
      paid_out += toNum(p.net_amount);
      paid_count++;
    } else if (p.status === 'pending' || p.status === 'processing') {
      pending_out += toNum(p.net_amount);
      pending_count++;
    }
  }

  return { fees_earned, paid_out, pending_out, paid_count, pending_count };
}
