// ─── Customer reliability metrics ───────────────────────────────────────────
//
// Pure calculation from the rows we already pull for the customer record.
// Kept in its own module so it's testable in isolation — no Supabase, no
// session.
//
// Inputs are deliberately wide: we accept the raw shape that comes back
// from the page's queries (plans rows + payments rows for one patient),
// and return a frozen summary the page can render directly.
//
// Definitions — locked here, not in the page, so future drift is caught
// by [[reliability-test]]:
//
//   total_financed     — Σ plans.total_amount, all-time, all statuses
//                        except 'declined' / 'pending_acceptance' (those
//                        plans never represented committed credit).
//   total_collected    — Σ payments.amount WHERE status = 'collected'.
//   total_outstanding  — Σ payments.amount WHERE status IN
//                        ('scheduled', 'processing', 'failed', 'retried').
//                        ('written_off' is gone — we ate the loss.)
//   on_time_rate       — collected_on_first_attempt / attempted_total.
//                        "Attempted" = anything not still 'scheduled' or
//                        'processing' (i.e. the charge has been tried at
//                        least once).
//                        "On time" = collected AND retry_count = 0
//                        (first-attempt success). Null when 0 attempts.
//   has_overdue        — at least one payment with status='scheduled' and
//                        due_date strictly before `today`.
//   has_written_off    — at least one payment with status='written_off'.
//   standing           — derived overall signal:
//                          'has-write-offs' (worst) >
//                          'has-overdue' >
//                          'good-standing'
//                        We rank write-offs above overdue because a
//                        write-off is a confirmed loss; an overdue row
//                        may still collect on the next cron run.

export type PlanRow = {
  total_amount: number | string;
  status:       string;
};

export type PaymentRow = {
  amount:       number | string;
  status:       string;
  due_date:     string;
  retry_count:  number | null;
};

export type Standing = 'good-standing' | 'has-overdue' | 'has-write-offs';

export type Reliability = {
  total_financed:    number;
  total_collected:   number;
  total_outstanding: number;
  on_time_rate:      number | null;
  on_time_collected: number;
  attempted_count:   number;
  failed_count:      number;
  written_off_count: number;
  has_overdue:       boolean;
  has_written_off:   boolean;
  standing:          Standing;
};

const PLAN_STATUS_EXCLUDE_FROM_FINANCED = new Set(['declined', 'pending_acceptance']);

const OUTSTANDING_STATUSES = new Set(['scheduled', 'processing', 'failed', 'retried']);
const ATTEMPTED_STATUSES   = new Set(['collected', 'failed', 'retried', 'written_off']);

function toNum(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

export function computeReliability(
  plans:    PlanRow[],
  payments: PaymentRow[],
  today:    string,
): Reliability {
  let total_financed    = 0;
  for (const p of plans) {
    if (PLAN_STATUS_EXCLUDE_FROM_FINANCED.has(p.status)) continue;
    total_financed += toNum(p.total_amount);
  }

  let total_collected   = 0;
  let total_outstanding = 0;
  let attempted_count   = 0;
  let on_time_collected = 0;
  let failed_count      = 0;
  let written_off_count = 0;
  let has_overdue       = false;

  for (const p of payments) {
    const amount = toNum(p.amount);
    const retry  = p.retry_count ?? 0;

    if (p.status === 'collected') {
      total_collected += amount;
      attempted_count++;
      if (retry === 0) on_time_collected++;
    } else if (OUTSTANDING_STATUSES.has(p.status)) {
      total_outstanding += amount;
      if (p.status === 'failed' || p.status === 'retried') {
        attempted_count++;
        failed_count++;
      }
      if (p.status === 'scheduled' && p.due_date < today) {
        has_overdue = true;
      }
    } else if (p.status === 'written_off') {
      attempted_count++;
      written_off_count++;
    }
  }

  const on_time_rate = attempted_count === 0 ? null : on_time_collected / attempted_count;

  const has_written_off = written_off_count > 0;
  const standing: Standing =
    has_written_off ? 'has-write-offs'
    : has_overdue   ? 'has-overdue'
    :                 'good-standing';

  return {
    total_financed,
    total_collected,
    total_outstanding,
    on_time_rate,
    on_time_collected,
    attempted_count,
    failed_count,
    written_off_count,
    has_overdue,
    has_written_off,
    standing,
  };
}

// ─── Standing display helpers ───────────────────────────────────────────────

export const STANDING_DISPLAY: Record<Standing, { label: string; cls: string; dot: string }> = {
  'good-standing':  { label: 'Good standing',  cls: 'bg-green-50 text-green-800 border-green-200', dot: 'bg-green-500' },
  'has-overdue':    { label: 'Has overdue',    cls: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-amber-500' },
  'has-write-offs': { label: 'Has write-offs', cls: 'bg-red-50   text-red-800   border-red-200',   dot: 'bg-red-500'   },
};

export function formatPercent(rate: number | null): string {
  if (rate == null) return '—';
  return `${Math.round(rate * 100)}%`;
}
