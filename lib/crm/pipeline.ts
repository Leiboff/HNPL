// ─── Pipeline value aggregation — pure functions ──────────────────────
//
// estimated_monthly_billings is the qualification variable (revenue is
// a percentage of billings). These functions turn a list of leads into
// the totals the board header and My Day render. Kept pure and
// dependency-free so they're trivially unit-testable and reusable
// between server components.

export type PipelineLead = {
  stage: string;
  estimated_monthly_billings: number | null;
  archived_at?: string | null;
};

const TERMINAL_LOST = 'lost';

// Rough close-probability per stage — used only for the WEIGHTED
// pipeline figure on My Day. A lead's raw estimated_monthly_billings
// still appears unweighted everywhere else (list, board cards, the
// per-stage board header totals).
export const STAGE_WEIGHTS: Record<string, number> = {
  new:                0.05,
  contacted:          0.10,
  meeting_scheduled:  0.20,
  demo_done:          0.35,
  agreement_sent:     0.60,
  signed:             0.90,
  onboarded:          1.00,
  lost:               0,
};

function activeLeads<T extends PipelineLead>(leads: T[]): T[] {
  return leads.filter(l => !l.archived_at && l.stage !== TERMINAL_LOST);
}

/** Sum of estimated_monthly_billings for non-archived, non-lost leads. */
export function sumPipelineValue(leads: PipelineLead[]): number {
  return activeLeads(leads).reduce((sum, l) => sum + (l.estimated_monthly_billings ?? 0), 0);
}

/** Sum of estimated_monthly_billings per stage, excluding archived leads. Lost leads ARE included per-stage (they still need a total on that column) but excluded from sumPipelineValue. */
export function pipelineValueByStage(leads: PipelineLead[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of leads) {
    if (l.archived_at) continue;
    out[l.stage] = (out[l.stage] ?? 0) + (l.estimated_monthly_billings ?? 0);
  }
  return out;
}

/** Sum of estimated_monthly_billings × STAGE_WEIGHTS[stage] for non-archived, non-lost leads. */
export function weightedPipelineValue(leads: PipelineLead[]): number {
  return activeLeads(leads).reduce(
    (sum, l) => sum + (l.estimated_monthly_billings ?? 0) * (STAGE_WEIGHTS[l.stage] ?? 0),
    0,
  );
}

export const MIN_SAMPLE_SIZE = 5;

/**
 * A KPI computed on fewer than MIN_SAMPLE_SIZE leads is misleading —
 * callers should render "not enough data yet" instead of a number.
 */
export function hasEnoughData(sampleSize: number): boolean {
  return sampleSize >= MIN_SAMPLE_SIZE;
}
