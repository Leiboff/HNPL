// ─── Single source of truth for a plan's lifecycle bucket ───────────────
//
// A plan's `status` maps to exactly one bucket, and every patient surface
// classifies it here — so a declined bill can never be treated as
// "finished" on one screen and rendered with the active-plan template on
// another (Phase 2 bug: declined items sat in the Finished list with a
// green success tick + a "Receipt" link that opened a plan-management
// screen showing "LEFT TO PAY R0.00" and a live card row).
//
// declined is its OWN bucket: nothing was charged, so it is neither a
// finished plan nor an active one — it gets a neutral row and a minimal
// "what happened" detail view, never the schedule/receipt/payment chrome.

export type PlanBucket =
  | 'pending'   // awaiting acceptance or first charge
  | 'active'    // paying off
  | 'finished'  // completed / cancelled / defaulted — a plan that existed
  | 'declined'; // the patient declined the bill — no plan, no money taken

export function planBucket(status: string): PlanBucket {
  switch (status) {
    case 'pending_acceptance':
    case 'pending_first_payment':
      return 'pending';
    case 'active':
      return 'active';
    case 'declined':
      return 'declined';
    // completed | cancelled | defaulted (and any future terminal state)
    default:
      return 'finished';
  }
}

/** True iff the plan was declined by the patient (no plan created). */
export function isDeclinedPlan(status: string): boolean {
  return planBucket(status) === 'declined';
}
