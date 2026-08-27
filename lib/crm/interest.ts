// ─── Lead interest — derived from contacts, never stored on the lead ──
//
// crm_lead_contacts.interest is per-contact (0115). A lead's displayed
// interest is DERIVED, not written anywhere: the hottest interest
// among decision-maker contacts, falling back to the hottest interest
// overall when the lead has no decision-maker contact on file, and
// 'unknown' when nothing on the lead has a value.

import { STAGES, TERMINAL_STAGES, type Stage } from './stages';

export const INTERESTS = ['unknown', 'cold', 'warm', 'hot'] as const;
export type Interest = (typeof INTERESTS)[number];

export const INTEREST_LABELS: Record<Interest, string> = {
  unknown: 'Unknown',
  cold:    'Cold',
  warm:    'Warm',
  hot:     'Hot',
};

const INTEREST_RANK: Record<Interest, number> = { unknown: 0, cold: 1, warm: 2, hot: 3 };

export type ContactForInterest = {
  interest: Interest;
  is_decision_maker: boolean;
};

function hottest(contacts: ContactForInterest[]): Interest {
  let best: Interest = 'unknown';
  for (const c of contacts) {
    if (INTEREST_RANK[c.interest] > INTEREST_RANK[best]) best = c.interest;
  }
  return best;
}

/**
 * Hottest interest among is_decision_maker contacts; falls back to the
 * hottest interest overall when the lead has no decision-maker contact
 * at all; 'unknown' when no contact has a value.
 */
export function deriveLeadInterest(contacts: ContactForInterest[]): Interest {
  const decisionMakers = contacts.filter(c => c.is_decision_maker);
  return hottest(decisionMakers.length > 0 ? decisionMakers : contacts);
}

const AGREEMENT_SENT_INDEX = STAGES.indexOf('agreement_sent');

/**
 * Soft nudge (never a block) — true when a lead is at agreement_sent or
 * a later WORKING stage (mirrors isMissingNextAction's TERMINAL_STAGES
 * exclusion in lib/crm/followups.ts) and has no decision-maker contact
 * on file.
 */
export function isMissingDecisionMaker(
  stage: string,
  contacts: Array<{ is_decision_maker: boolean }>,
): boolean {
  if (TERMINAL_STAGES.has(stage as Stage)) return false;
  // Nurture can be entered from any earlier stage (a timing/budget
  // soft-no right after 'contacted', say) — its position in STAGES
  // doesn't mean "further along the funnel", so it's excluded from
  // this index-based check rather than treated as past agreement_sent.
  if (stage === 'nurture') return false;
  if (STAGES.indexOf(stage as Stage) < AGREEMENT_SENT_INDEX) return false;
  return !contacts.some(c => c.is_decision_maker);
}
