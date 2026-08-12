// ─── Brand revenue dashboard — pure aggregation logic ──────────────────
//
// Active-only revenue for a brand-admin's group, with gross⇄net toggle
// and filter-by-practice / filter-by-doctor. No payment / collection
// progress data — the provider sees BILL-LEVEL gross/net on activated
// plans only. Collection state is BetterNow's concern, not theirs.
//
// What counts as "active" for revenue
// ───────────────────────────────────
// The brief: "Active plans ONLY. Exclude rejected, pending,
// unactivated, defaulted/written-off."
//
//   plans.status values (per 0007 + 0013):
//     • pending_acceptance     — patient hasn't accepted    → EXCLUDE
//     • pending_first_payment  — accepted, not yet activated → EXCLUDE
//     • active                 — activated; payout initiated → INCLUDE
//     • completed              — fully collected; was paid   → INCLUDE
//     • defaulted              — instalments stopped         → EXCLUDE
//     • cancelled              — voided                      → EXCLUDE
//     • declined               — patient rejected            → EXCLUDE
//
// Rationale for INCLUDE-ing `completed`: a completed plan was
// activated (the practice was paid on the active transition), and
// completion is just the final-instalment lifecycle event. From the
// provider's revenue ledger, completed and active plans are the same
// revenue — they're both "activated and paid out". The brief's
// exclusion list explicitly names everything else; `completed` is not
// in it. The current dashboard's bug was counting pending_acceptance
// (never activated) — that's the regression this module fixes.
//
// Gross vs net
// ─────────────
// • Gross = total_amount on each active plan (the FULL bill, not
//   amount-collected-so-far).
// • Net   = gross × (1 − fee_percent / 100), per the practice's
//   fee_percent at the time of aggregation.
// fee_percent lives on practices and is brand-admin-visible (the
// commercial term they signed). The patient-discovery view masks it;
// here it's deliberately surfaced because brand-admins are the
// contracted counterparty.

import { calculateFee } from '@/lib/finance';

// ─── Inputs ────────────────────────────────────────────────────────────

export type RevenuePlan = {
  id:           string;
  practice_id:  string;
  // The treating practitioner's MEMBERSHIP id (0094). Roster-only
  // practitioners have one of these and no profile, which is the point.
  provider_member_id: string | null;
  total_amount: number;        // gross, in rands
  status:       string;
};

export type RevenuePractice = {
  id:           string;
  name:         string;
  fee_percent:  number;
};

export type RevenueProvider = {
  id:        string;
  fullName:  string;
};

export type RevenueFilter = {
  practiceId?:  string | null;  // null/undefined = all branches
  providerId?:  string | null;  // null/undefined = all doctors
};

export type RevenueRow = {
  id:        string;            // practice_id or provider_member_id
  label:     string;            // practice name or provider full name
  count:     number;            // number of active plans contributing
  gross:     number;            // sum of total_amount (rands)
  net:       number;            // gross − commission per the practice's fee_percent
};

export type RevenueSummary = {
  totalCount: number;
  totalGross: number;
  totalNet:   number;
  byPractice: RevenueRow[];   // each branch's slice
  byProvider: RevenueRow[];   // each doctor's slice
};

// ─── Status filter ─────────────────────────────────────────────────────

const ACTIVE_FOR_REVENUE = new Set(['active', 'completed']);

/** Pure predicate — exported so source-text tests can pin it. */
export function isActiveForRevenue(status: string): boolean {
  return ACTIVE_FOR_REVENUE.has(status);
}

// ─── computeRevenue ────────────────────────────────────────────────────
//
// One pass over plans. Drops every non-active-for-revenue row, applies
// the practice/provider filter, then accumulates by practice and by
// provider. fee_percent lookups go through a Map keyed on
// practice.id; missing entries default to 0 (so a plan whose practice
// row didn't make it into the query just contributes gross=net, which
// is the right fail-safe — we never silently inflate fee).

export function computeRevenue(
  plans:     RevenuePlan[],
  practices: RevenuePractice[],
  providers: RevenueProvider[],
  filter:    RevenueFilter = {},
): RevenueSummary {
  const feeByPractice  = new Map<string, number>();
  const nameByPractice = new Map<string, string>();
  for (const p of practices) {
    feeByPractice.set(p.id,  p.fee_percent);
    nameByPractice.set(p.id, p.name);
  }
  const nameByProvider = new Map<string, string>();
  for (const r of providers) {
    nameByProvider.set(r.id, r.fullName);
  }

  type Bucket = { count: number; gross: number; net: number };
  const byPractice = new Map<string, Bucket>();
  const byProvider = new Map<string, Bucket>();

  let totalCount = 0;
  let totalGross = 0;
  let totalNet   = 0;

  for (const plan of plans) {
    if (!isActiveForRevenue(plan.status)) continue;
    if (filter.practiceId && plan.practice_id !== filter.practiceId) continue;
    if (filter.providerId && plan.provider_member_id !== filter.providerId) continue;

    const feePct = feeByPractice.get(plan.practice_id) ?? 0;
    const { gross, net } = calculateFee(Number(plan.total_amount), feePct);

    totalCount += 1;
    totalGross += gross;
    totalNet   += net;

    {
      const b = byPractice.get(plan.practice_id) ?? { count: 0, gross: 0, net: 0 };
      b.count += 1; b.gross += gross; b.net += net;
      byPractice.set(plan.practice_id, b);
    }
    if (plan.provider_member_id) {
      const b = byProvider.get(plan.provider_member_id) ?? { count: 0, gross: 0, net: 0 };
      b.count += 1; b.gross += gross; b.net += net;
      byProvider.set(plan.provider_member_id, b);
    }
  }

  const byPracticeRows: RevenueRow[] = Array.from(byPractice.entries())
    .map(([id, b]) => ({
      id,
      label: nameByPractice.get(id) ?? id,
      count: b.count,
      gross: round2(b.gross),
      net:   round2(b.net),
    }))
    .sort((a, b) => b.gross - a.gross);

  const byProviderRows: RevenueRow[] = Array.from(byProvider.entries())
    .map(([id, b]) => ({
      id,
      label: nameByProvider.get(id) ?? '(unknown practitioner)',
      count: b.count,
      gross: round2(b.gross),
      net:   round2(b.net),
    }))
    .sort((a, b) => b.gross - a.gross);

  return {
    totalCount,
    totalGross: round2(totalGross),
    totalNet:   round2(totalNet),
    byPractice: byPracticeRows,
    byProvider: byProviderRows,
  };
}

// Two-decimal round to keep the rand totals stable against
// floating-point drift across hundreds of plans (the calculateFee
// rounds at cents per-plan, but the SUM can still drift in JS).
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
