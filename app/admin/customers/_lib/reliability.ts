// ─── Customer reliability metrics ───────────────────────────────────────────
//
// Pure calculation from the rows we already pull for the customer record.
// Kept in its own module so it's testable in isolation — no Supabase, no
// session. Shared with Practice 360 / book-health when that's built.
//
// Definitions — locked here, not in the page, so future drift is caught
// by [[reliability-test]]:
//
// total_financed
//   Σ plans.total_amount across plans that REPRESENTED committed credit.
//   Excludes "non-start" plans (pending_acceptance / declined / cancelled)
//   — those never ran a charge and so were never owed by HNPL.
//
// total_collected
//   Σ payments.amount WHERE status = 'collected'.
//
//   "In full" assumption — verified against the current code path:
//     - chargeInstalment.ts passes the full scheduled amount to
//       Peach's MIT charge /v1/registrations/{id}/payments (no partial amounts).
//     - The webhook sets status='collected' on payment success without
//       comparing the captured amount to payments.amount.
//     - There is no `collected_amount` / `partial` column on payments.
//   So 'collected' ALREADY means "full scheduled amount captured" by
//   construction of the charge pipeline. No extra in-full check here.
//   If the schema ever grows partial-collection support, also gate the
//   numerator below on "captured == scheduled".
//
// total_outstanding (= outstanding_on_track + outstanding_at_risk)
//   Outstanding is split into two buckets — a single number blends
//   "expected to collect" with "should have collected but hasn't":
//     outstanding_on_track — Σ amount where status IN ('scheduled', 'processing')
//                            (in-flight; the cron expects these to collect)
//     outstanding_at_risk  — Σ amount where status IN ('failed', 'retried')
//                            (charge attempted, did not succeed — under
//                            retry cap, will be tried again)
//   Written-off rows are NOT outstanding (loss eaten); collected rows
//   are not outstanding either.
//
// reliability_rate (the headline metric)
//   The salary-date first-attempt collection rate. Numerator and
//   denominator BOTH exclude instalment 1 — instalment 1 is charged
//   immediately at plan acceptance against a just-verified card via
//   /patient/actions.ts → payWithSavedCard, so it is on-time by
//   construction and contributes no signal. Reliability is about the
//   FUTURE salary-date collections (instalments 2..N).
//
//     numerator   = count of payments where
//                     instalment_number > 1
//                     AND status = 'collected'
//                     AND retry_count = 0          (first-attempt success)
//
//     denominator = count of payments where
//                     instalment_number > 1
//                     AND due_date <= today        (has come due — could
//                                                   have been a hit or miss)
//                     AND status IN ('collected', 'failed', 'retried',
//                                    'written_off')
//                                                   (actually attempted —
//                                                   exclude 'processing'
//                                                   which is in-flight)
//
//   When denominator = 0 the rate is null — a brand-new patient hasn't
//   proven anything; do NOT show "100% on time" for zero data.
//
// salary_date_failed_count / salary_date_written_off_count
//   Visible risk-count signals. "failed" combines failed + retried.
//   Both restrict to instalment_number > 1 — instalment 1 noise has
//   no place in the salary-date risk picture.
//
// Standing classification is intentionally NOT a field on this
// shape — it's a separate concern shared between Customer 360 and
// Practice 360 via app/admin/_lib/standing.ts. This file produces
// the raw numbers; the standing lib turns them into a band + verdict.

export type PlanRow = {
  total_amount: number | string;
  status:       string;
};

export type PaymentRow = {
  amount:            number | string;
  status:            string;
  due_date:          string;
  retry_count:       number | null;
  instalment_number: number;
};

export type Reliability = {
  // Financial totals
  total_financed:    number;
  total_collected:   number;

  // Outstanding, split
  total_outstanding:        number;
  outstanding_on_track:     number;
  outstanding_at_risk:      number;

  // Salary-date first-attempt rate (instalment > 1 only)
  reliability_rate:            number | null;
  salary_date_due_count:       number;   // denominator
  salary_date_on_time_count:   number;   // numerator

  // Salary-date risk counts (instalment > 1 only)
  salary_date_failed_count:        number;
  salary_date_written_off_count:   number;

  // Raw flags — callers pass these into the shared standing classifier.
  has_overdue:       boolean;
  has_written_off:   boolean;
};

// Plans that NEVER ran. Excluded from total_financed because they never
// represented committed credit. They also belong off "Plan history" in
// the UI — they're non-starts, not history.
const PLAN_STATUS_NON_STARTS = new Set(['pending_acceptance', 'declined', 'cancelled']);

const OUTSTANDING_ON_TRACK_STATUSES = new Set(['scheduled', 'processing']);
const OUTSTANDING_AT_RISK_STATUSES  = new Set(['failed', 'retried']);
const ATTEMPTED_STATUSES            = new Set(['collected', 'failed', 'retried', 'written_off']);

function toNum(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

export function computeReliability(
  plans:    PlanRow[],
  payments: PaymentRow[],
  today:    string,
): Reliability {
  // ── total_financed ────────────────────────────────────────────────────
  let total_financed = 0;
  for (const p of plans) {
    if (PLAN_STATUS_NON_STARTS.has(p.status)) continue;
    total_financed += toNum(p.total_amount);
  }

  // ── payment sweeps ────────────────────────────────────────────────────
  let total_collected             = 0;
  let outstanding_on_track        = 0;
  let outstanding_at_risk         = 0;
  let salary_date_due_count       = 0;
  let salary_date_on_time_count   = 0;
  let salary_date_failed_count    = 0;
  let salary_date_written_off_count = 0;
  let has_overdue                 = false;
  let has_written_off             = false;

  for (const p of payments) {
    const amount   = toNum(p.amount);
    const retry    = p.retry_count ?? 0;
    const isSalary = p.instalment_number > 1;
    const isDue    = p.due_date <= today;
    const attempted = ATTEMPTED_STATUSES.has(p.status);

    // Financial sums (instalment 1 included — money is money)
    if (p.status === 'collected') {
      total_collected += amount;
    } else if (OUTSTANDING_ON_TRACK_STATUSES.has(p.status)) {
      outstanding_on_track += amount;
      if (p.status === 'scheduled' && p.due_date < today) {
        has_overdue = true;
      }
    } else if (OUTSTANDING_AT_RISK_STATUSES.has(p.status)) {
      outstanding_at_risk += amount;
    } else if (p.status === 'written_off') {
      has_written_off = true;
    }

    // Salary-date reliability — instalment > 1 only
    if (isSalary) {
      if (p.status === 'failed' || p.status === 'retried') salary_date_failed_count++;
      if (p.status === 'written_off')                       salary_date_written_off_count++;

      if (isDue && attempted) {
        salary_date_due_count++;
        if (p.status === 'collected' && retry === 0) {
          salary_date_on_time_count++;
        }
      }
    }
  }

  const total_outstanding = outstanding_on_track + outstanding_at_risk;

  const reliability_rate = salary_date_due_count === 0
    ? null
    : salary_date_on_time_count / salary_date_due_count;

  return {
    total_financed,
    total_collected,

    total_outstanding,
    outstanding_on_track,
    outstanding_at_risk,

    reliability_rate,
    salary_date_due_count,
    salary_date_on_time_count,

    salary_date_failed_count,
    salary_date_written_off_count,

    has_overdue,
    has_written_off,
  };
}

export function formatPercent(rate: number | null): string {
  if (rate == null) return 'N/A';
  return `${Math.round(rate * 100)}%`;
}
