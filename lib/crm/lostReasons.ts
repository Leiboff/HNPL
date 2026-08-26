// ─── Lost-reason vocabulary — mirrors crm_leads_lost_reason_check ─────
//
// Single source of truth for the picker UI. Keep in sync with the
// CHECK constraint added in supabase/migrations/0110_crm_segmentation.sql.

export const LOST_REASONS = [
  'price', 'uses_competitor', 'no_need', 'no_decision_maker',
  'unresponsive', 'not_eligible', 'other',
] as const;

export type LostReason = (typeof LOST_REASONS)[number];

export const LOST_REASON_LABELS: Record<LostReason, string> = {
  price:              'Price',
  uses_competitor:    'Uses a competitor',
  no_need:            'No need',
  no_decision_maker:  'No decision maker',
  unresponsive:       'Unresponsive',
  not_eligible:       'Not eligible',
  other:              'Other',
};
