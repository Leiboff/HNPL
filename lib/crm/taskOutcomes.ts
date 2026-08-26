// ─── Task outcome vocabulary — mirrors crm_tasks' outcome CHECK ───────
// (supabase/migrations/0107_crm_tasks.sql)

export const TASK_OUTCOMES = ['reached', 'no_answer', 'gatekeeper', 'rescheduled', 'not_interested', 'done'] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export const TASK_OUTCOME_LABELS: Record<TaskOutcome, string> = {
  reached:        'Reached',
  no_answer:      'No answer',
  gatekeeper:     'Gatekeeper',
  rescheduled:    'Rescheduled',
  not_interested: 'Not interested',
  done:           'Done',
};
