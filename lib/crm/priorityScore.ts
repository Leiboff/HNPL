// ─── Lead priority score — pure, single source of truth ───────────────
//
// Every score MUST render alongside its reason — a score without a
// justification is a score the user ignores (Phase 3 spec, 3.3). This
// module is the ONLY place scoring weights live; nothing else computes
// a score inline. Pure: same input always produces the same output, no
// clock/network reads inside — callers pass `now` explicitly.
//
// Inputs are deliberately restricted to columns that already exist
// after Phase 1/2 — no new columns, per the Phase 3 brief ("do not
// change scoring inputs that would require new columns").

export type LeadScoreInput = {
  stage: string;
  estimatedMonthlyBillings: number | null;
  nextFollowUpAt: string | null;    // crm_leads.next_follow_up_at (derived from crm_tasks)
  lastStageChangeAt: string | null; // latest crm_activities.occurred_at where type='stage_change'
  lastActivityAt: string | null;    // latest crm_activities.occurred_at of ANY type
  hasUnansweredReply: boolean;      // most recent activity is type='email_reply' with nothing logged after it
  distanceKm: number | null;        // optional — null when the viewer's location isn't available
};

export type LeadScore = {
  score: number;      // 0-100
  reason: string;      // always non-empty
};

const TERMINAL_STAGES = new Set(['signed', 'onboarded', 'lost']);

const WEIGHTS = {
  overdueFollowUp:    40,
  dueTodayFollowUp:   25,
  unansweredReply:    30,
  stalledPerWeek:     6,     // per week since last stage change, capped
  stalledCap:         24,
  highValuePer10k:    4,     // per R10,000/mo estimated billings, capped
  highValueCap:       20,
  nearby:             10,    // within NEARBY_KM
} as const;

const NEARBY_KM = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return null;
  return (now.getTime() - d) / MS_PER_DAY;
}

/**
 * Score + human-readable reason for one lead. Terminal-stage leads
 * (signed/onboarded/lost) score 0 with a fixed reason — they don't
 * belong in a ranked working queue.
 */
export function computeLeadScore(input: LeadScoreInput, now: Date): LeadScore {
  if (TERMINAL_STAGES.has(input.stage)) {
    return { score: 0, reason: `${input.stage[0].toUpperCase()}${input.stage.slice(1)} — not part of the working queue.` };
  }

  const contributions: Array<{ points: number; reason: string }> = [];

  const followUpDays = daysSince(input.nextFollowUpAt, now);
  if (followUpDays !== null) {
    if (followUpDays > 0) {
      const wholeDays = Math.floor(followUpDays);
      contributions.push({
        points: WEIGHTS.overdueFollowUp,
        reason: `Follow-up overdue by ${wholeDays} day${wholeDays === 1 ? '' : 's'}.`,
      });
    } else if (followUpDays > -1) {
      contributions.push({ points: WEIGHTS.dueTodayFollowUp, reason: 'Follow-up due today.' });
    }
  }

  if (input.hasUnansweredReply) {
    contributions.push({ points: WEIGHTS.unansweredReply, reason: 'Unanswered reply waiting.' });
  }

  const stalledDays = daysSince(input.lastStageChangeAt, now);
  if (stalledDays !== null && stalledDays > 7) {
    const weeks = Math.floor(stalledDays / 7);
    contributions.push({
      points: Math.min(WEIGHTS.stalledPerWeek * weeks, WEIGHTS.stalledCap),
      reason: `No stage movement in ${weeks} week${weeks === 1 ? '' : 's'}.`,
    });
  }

  if (input.estimatedMonthlyBillings && input.estimatedMonthlyBillings > 0) {
    const units = input.estimatedMonthlyBillings / 10_000;
    contributions.push({
      points: Math.min(WEIGHTS.highValuePer10k * units, WEIGHTS.highValueCap),
      reason: `High value — est. R${Math.round(input.estimatedMonthlyBillings).toLocaleString('en-ZA')}/mo.`,
    });
  }

  if (input.distanceKm !== null && input.distanceKm <= NEARBY_KM) {
    contributions.push({ points: WEIGHTS.nearby, reason: `Nearby — ${input.distanceKm.toFixed(1)}km away.` });
  }

  if (contributions.length === 0) {
    return { score: 0, reason: 'No urgent signal — due for a routine check-in.' };
  }

  const score = Math.min(100, Math.round(contributions.reduce((sum, c) => sum + c.points, 0)));
  const dominant = contributions.reduce((a, b) => (b.points > a.points ? b : a));
  return { score, reason: dominant.reason };
}
