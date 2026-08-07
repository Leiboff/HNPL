import { deriveInstalmentStatus, type InstalmentForStatus } from './instalmentStatus';

// ─── Single source of truth for "what does this patient still owe" ───────
//
// The Plans header ("R X outstanding · N overdue") and the home hero's
// overdue card both read from HERE, so the two can never disagree — the bug
// this closes was the hero showing ONE overdue instalment's amount while the
// patient had several overdue, letting them underpay and stay in arrears.
//
// Overdue is DERIVED (deriveInstalmentStatus), never trusted from the raw
// status — the same rule the schedule and Plans header use. Amounts are in
// cents and include dunning fees, matching the Plans header's existing math.

export type OutstandingInstalment = InstalmentForStatus & {
  amount:              number | string;
  dunning_fees_cents?: number | null;
};

export type OutstandingSummary = {
  /** Money still owed (scheduled + processing + failed + defaulted). */
  outstandingCents:  number;
  outstandingCount:  number;
  /** The subset that is past due (deriveInstalmentStatus === 'overdue'). */
  overdueCents:      number;
  overdueCount:      number;
};

// Money still owed. `deriveInstalmentStatus` decides which of these are also
// OVERDUE; this set just excludes settled rows (collected / written_off).
const OUTSTANDING_STATUSES = new Set(['scheduled', 'processing', 'failed', 'defaulted']);

function instalmentCents(p: OutstandingInstalment): number {
  return Math.round(Number(p.amount) * 100) + Number(p.dunning_fees_cents ?? 0);
}

/**
 * Aggregate a patient's instalments into outstanding + overdue totals/counts.
 * `today` is a SAST YYYY-MM-DD string (todaySAST()).
 */
export function summariseOutstanding(
  instalments: OutstandingInstalment[],
  today: string,
): OutstandingSummary {
  let outstandingCents = 0;
  let outstandingCount = 0;
  let overdueCents = 0;
  let overdueCount = 0;

  for (const p of instalments) {
    if (!OUTSTANDING_STATUSES.has(p.status)) continue;
    const cents = instalmentCents(p);
    outstandingCents += cents;
    outstandingCount += 1;
    if (deriveInstalmentStatus(p, today) === 'overdue') {
      overdueCents += cents;
      overdueCount += 1;
    }
  }

  return { outstandingCents, outstandingCount, overdueCents, overdueCount };
}
