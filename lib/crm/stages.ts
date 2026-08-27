// ─── Stage vocabulary — single source of truth ────────────────────────
//
// Every consumer of crm_leads.stage (and crm_activities.from_stage/
// to_stage) must import from here instead of declaring its own literal
// array or Set. Mirrors the CHECK constraints in
// supabase/migrations/0069_crm_leads_and_activities.sql (crm_leads.stage)
// and 0108_crm_stage_transition_columns.sql (crm_activities.from_stage/
// to_stage) — keep both in sync with this list by hand; the DB side is
// SQL and can't import TS.

export const STAGES = [
  'new', 'contacted', 'meeting_scheduled', 'demo_done',
  'agreement_sent', 'nurture', 'signed', 'onboarded', 'lost',
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  new:                'New',
  contacted:          'Contacted',
  meeting_scheduled:  'Meeting scheduled',
  demo_done:          'Demo done',
  agreement_sent:     'Agreement sent',
  nurture:            'Nurture',
  signed:             'Signed',
  onboarded:          'Onboarded',
  lost:               'Lost',
};

// Per-stage stall threshold (days since last stage change before
// lib/crm/priorityScore.ts's stalled signal contributes). 0 means
// "date-driven, no stall" — that stage's own date signal (e.g. a
// scheduled meeting) already covers timing, so a flat staleness clock
// would be redundant. A stage absent from this map (nurture; the
// terminal stages, which short-circuit before reaching stalled scoring
// at all) is likewise treated as "no stall" — nurture in particular is
// deliberately paused, not stalled, and is driven by nurture_wake_at.
export const STAGE_STALL_DAYS: Partial<Record<Stage, number>> = {
  new:               3,
  contacted:         5,
  meeting_scheduled: 0,
  demo_done:         7,
  agreement_sent:    5,
};

// Stages where a lead is fully closed out (won or lost) — excluded from
// working queues, follow-up bucketing, priority scoring, and reply
// ingest tracking. Typed Set<string> (not Set<Stage>) — every consumer
// checks membership against a loosely-typed `string` stage read off a
// DB row, and Set<T>.has() requires exactly T.
export const TERMINAL_STAGES: Set<string> = new Set<Stage>(['signed', 'onboarded', 'lost']);

// Everything still "in flight" — the complement of TERMINAL_STAGES.
export const WORKING_STAGES: Stage[] = STAGES.filter(s => !TERMINAL_STAGES.has(s));
