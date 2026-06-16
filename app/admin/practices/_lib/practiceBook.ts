// ─── Practice book health + payout aggregation ─────────────────────────────
//
// Pure helpers for Practice 360 — both tested in isolation in
// [[practiceBook-test]]. They are the practice-side counterparts to
// Customer 360's reliability calc:
//
//   - sumPayouts(rows)
//       Reduces the practice's payouts into the three numbers the
//       record actually wants to surface:
//         fees_earned — BetterNow's MDR revenue from this practice
//                       (Σ fee_amount, excluding 'failed' payouts —
//                        a failed payout means the cash never moved
//                        so it isn't realized revenue).
//         paid_out    — net_amount across 'paid' payouts
//         pending_out — net_amount across 'pending' / 'processing'
//       Plus row counts for the summary chips.
//
//   - classifyBookHealth(reliability)
//       Three-tier focus-area classifier driven by the SAME salary-date
//       first-attempt reliability metric Customer 360 uses
//       (reliability.reliability_rate). The bands were picked to
//       surface practices whose patients default heavily as a focus
//       area — i.e. the operator scans the practice list and the red
//       chips tell them where to look.
//
//       Thresholds:
//         reliability_rate >= 0.85  → healthy
//         reliability_rate >= 0.70  → watch
//         reliability_rate <  0.70  → focus-area
//
//       Hard override: any salary-date written-off → focus-area
//       (a confirmed loss is unambiguous; ignore the rate band).
//
//       Sample-size guard: fewer than 3 salary-date installments
//       attempted → insufficient-data. Picking a band on 1–2 data
//       points produces misleading red chips for brand-new practices.
//
// Both helpers are tiny and intentional — they bake in the operator's
// vocabulary so the practice list, header chip, and tile colouring
// stay coherent.

import { type Reliability } from '../../customers/_lib/reliability';

// ─── Book health classifier ─────────────────────────────────────────────────

export type BookHealth =
  | 'healthy'
  | 'watch'
  | 'focus-area'
  | 'insufficient-data';

export const BOOK_HEALTH_DISPLAY: Record<BookHealth, { label: string; cls: string; dot: string }> = {
  'healthy':           { label: 'Healthy book',      cls: 'bg-green-50 text-green-800 border-green-200', dot: 'bg-green-500' },
  'watch':             { label: 'Watch',             cls: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-amber-500' },
  'focus-area':        { label: 'Focus area',        cls: 'bg-red-50   text-red-800   border-red-200',   dot: 'bg-red-500'   },
  'insufficient-data': { label: 'Too new to judge',  cls: 'bg-gray-50  text-gray-600  border-gray-200',  dot: 'bg-gray-300'  },
};

// Tunables. Kept as named exports so tests assert the contract directly.
export const MIN_SAMPLE_SIZE  = 3;
export const FOCUS_RATE_BELOW = 0.70;
export const WATCH_RATE_BELOW = 0.85;

export function classifyBookHealth(r: Reliability): BookHealth {
  // Any written-off salary-date installment is a confirmed loss for the
  // operator — surface as focus-area regardless of rate or sample size.
  if (r.salary_date_written_off_count > 0) return 'focus-area';

  // Without enough salary-date attempts, a rate is meaningless — a
  // brand-new practice with 1 collected, 0 failed is at 100% but
  // proves nothing.
  if (r.salary_date_due_count < MIN_SAMPLE_SIZE) return 'insufficient-data';
  if (r.reliability_rate == null)                return 'insufficient-data';

  if (r.reliability_rate < FOCUS_RATE_BELOW) return 'focus-area';
  if (r.reliability_rate < WATCH_RATE_BELOW) return 'watch';
  return 'healthy';
}

// ─── Payout aggregation ─────────────────────────────────────────────────────

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
