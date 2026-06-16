// ─── Shared standing vocabulary (Customer + Practice) ──────────────────────
//
// One four-band model used identically on Customer 360 and Practice
// 360 (and any future "X 360"). Same words, same colours, same
// thresholds — the operator never has to translate vocabulary in their
// head, and the bands can't drift out of sync.
//
// Bands, from worst to best:
//
//   at-risk (red)
//     - any salary-date written_off (hard override — confirmed loss),
//       OR
//     - any outstanding currently in at-risk status (failed/retried —
//       money should have collected and hasn't), OR
//     - salary-date reliability < 70% with a real sample (>=3 attempts)
//
//   watch (amber)
//     - has overdue scheduled (cron should have caught it), OR
//     - salary-date reliability 70–85% with a real sample
//
//   healthy (green)
//     - salary-date reliability >= 85% with a real sample, AND
//     - no overdue, no at-risk, no write-offs
//
//   too-new (gray)
//     - everything else — not enough signal to commit to a band
//
// The signal hierarchy means the band wins as the headline; the rate
// is supporting detail beneath it. Concretely this resolves the
// "Good standing AND 0% on-time" contradiction the previous Customer
// 360 had: at 0% with >=3 attempts the customer is at-risk, full stop —
// the standing chip and the rate now tell one consistent story.
//
// Practice "dormant" — a practice that has been approved but has no
// plans at all — is a sub-case of too-new (no signal yet), labelled
// distinctively in the verdict line below.
//
// The minimum sample size (3) avoids landing a brand-new entity in
// healthy/watch/at-risk on 1-2 data points; it does NOT apply to the
// hard overrides (written-off, at-risk outstanding), which fire on
// any sample size because they reflect confirmed unresolved trouble.

import { type Reliability } from '../customers/_lib/reliability';

export type Standing = 'healthy' | 'watch' | 'at-risk' | 'too-new';

// Tunables — exported so tests assert the contract.
export const MIN_SAMPLE_SIZE   = 3;
export const AT_RISK_RATE_BELOW = 0.70;
export const WATCH_RATE_BELOW   = 0.85;

export function computeStanding(reliability: Reliability): Standing {
  // Hard overrides: confirmed unresolved trouble, regardless of sample.
  if (reliability.salary_date_written_off_count > 0) return 'at-risk';
  if (reliability.outstanding_at_risk > 0)           return 'at-risk';

  const sample = reliability.salary_date_due_count;
  const rate   = reliability.reliability_rate;

  // Rate-based bands — only when sample is large enough to mean anything.
  if (sample >= MIN_SAMPLE_SIZE && rate != null) {
    if (rate < AT_RISK_RATE_BELOW) return 'at-risk';
    if (rate < WATCH_RATE_BELOW)   return 'watch';
    return 'healthy';
  }

  // Overdue without an at-risk amount is "friction not yet failure" —
  // surfaces as watch so the operator sees it without escalating.
  if (reliability.has_overdue) return 'watch';

  // No signal commits to a band yet.
  return 'too-new';
}

// ─── Display config — shared chip styling ───────────────────────────────────

export const STANDING_DISPLAY: Record<Standing, {
  label:  string;
  cls:    string;   // chip pill classes (background + text + border)
  dot:    string;   // dot colour class
  tone:   'good' | 'warn' | 'alert' | 'default';
}> = {
  'healthy': {
    label: 'Healthy',
    cls:   'bg-green-50 text-green-800 border-green-200',
    dot:   'bg-green-500',
    tone:  'good',
  },
  'watch': {
    label: 'Watch',
    cls:   'bg-amber-50 text-amber-800 border-amber-200',
    dot:   'bg-amber-500',
    tone:  'warn',
  },
  'at-risk': {
    label: 'At risk',
    cls:   'bg-red-50 text-red-800 border-red-200',
    dot:   'bg-red-500',
    tone:  'alert',
  },
  'too-new': {
    label: 'Too new to judge',
    cls:   'bg-gray-50 text-gray-600 border-gray-200',
    dot:   'bg-gray-300',
    tone:  'default',
  },
};

// ─── Verdict line — one-line plain-language summary of the state ───────────
//
// The verdict is what the operator reads first. The band sets the
// colour; this picks the right words for the specific signal driving
// the band. Always present — even for "healthy" — so the page leads
// with a sentence, not a chip.

import { formatRand } from './format';

export type VerdictContext = {
  plansCount?:     number;           // for "no plans yet" detection
  practiceStatus?: string;           // 'pending' | 'approved' | 'suspended' | 'inactive' — practice-only
};

export function verdictFor(
  standing:    Standing,
  reliability: Reliability,
  ctx:         VerdictContext = {},
): { headline: string; subline: string | null } {
  // Practice status overrides — a suspended practice's book doesn't
  // matter operationally; the status is the headline.
  if (ctx.practiceStatus === 'pending') {
    return { headline: 'Awaiting approval', subline: 'Review identity, banking, and HPCSA before approving.' };
  }
  if (ctx.practiceStatus === 'suspended') {
    return { headline: 'Suspended', subline: 'No new plans accepted; existing collections continue.' };
  }
  if (ctx.practiceStatus === 'inactive') {
    return { headline: 'Inactive', subline: null };
  }

  // No plans at all = dormant subcase of too-new.
  if (ctx.plansCount === 0) {
    const dormantHead = ctx.practiceStatus === 'approved'
      ? 'Approved · no activity yet'
      : 'No plans yet';
    return { headline: dormantHead, subline: null };
  }

  switch (standing) {
    case 'at-risk': {
      if (reliability.salary_date_written_off_count > 0) {
        return {
          headline: `At risk — ${reliability.salary_date_written_off_count} written off`,
          subline:  reliability.outstanding_at_risk > 0
            ? `${formatRand(reliability.outstanding_at_risk)} currently at risk too.`
            : 'Confirmed loss on at least one instalment.',
        };
      }
      if (reliability.outstanding_at_risk > 0) {
        const n = reliability.salary_date_failed_count;
        const failedLabel = n > 0
          ? `${n} failed installment${n === 1 ? '' : 's'}`
          : 'a failed installment';
        return {
          headline: `At risk — ${failedLabel}`,
          subline:  `${formatRand(reliability.outstanding_at_risk)} currently at risk.`,
        };
      }
      // Rate-only at-risk.
      const pct = reliability.reliability_rate == null ? '0%' : `${Math.round(reliability.reliability_rate * 100)}%`;
      return {
        headline: `At risk — only ${pct} first-try`,
        subline:  `${reliability.salary_date_on_time_count} of ${reliability.salary_date_due_count} salary-date instalments collected first try.`,
      };
    }
    case 'watch': {
      if (reliability.has_overdue) {
        return {
          headline: 'Watch — overdue collection',
          subline:  'Cron should have picked it up; check cron health if it persists.',
        };
      }
      const pct = reliability.reliability_rate == null ? '?' : `${Math.round(reliability.reliability_rate * 100)}%`;
      return {
        headline: `Watch — ${pct} first-try`,
        subline:  `${reliability.salary_date_on_time_count} of ${reliability.salary_date_due_count} salary-date instalments collected first try.`,
      };
    }
    case 'healthy': {
      const pct = reliability.reliability_rate == null ? '100%' : `${Math.round(reliability.reliability_rate * 100)}%`;
      return {
        headline: 'Healthy',
        subline:  `${pct} of salary-date instalments collect first try.`,
      };
    }
    case 'too-new': {
      // Has plans but no salary-date attempts have come due yet.
      return {
        headline: 'Too new to judge',
        subline:  'No salary-date collections have come due yet — standing builds with the next collection cycle.',
      };
    }
  }
}
