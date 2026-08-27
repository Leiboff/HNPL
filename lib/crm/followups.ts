// ─── Follow-up bucketing — overdue / today / upcoming ─────────────────
//
// Pure functions. Given a list of {id, next_follow_up_at} rows plus a
// `now`, return three arrays. All windowing is in SAST via
// sastDayWindows(now). Rows with a NULL next_follow_up_at are excluded
// from every bucket — they are "unscheduled" and surfaced separately
// (see /crm My Day view).

import { sastDayWindows } from './timezone';
import { TERMINAL_STAGES } from './stages';

export type FollowupRow = {
  id: string;
  next_follow_up_at: string | null;  // ISO
  stage?: string;
};

export type Buckets<T extends FollowupRow> = {
  overdue:  T[];
  today:    T[];
  upcoming: T[];   // next 7 days AFTER today (i.e. tomorrow → +7)
};

export function bucketFollowups<T extends FollowupRow>(rows: T[], now: Date): Buckets<T> {
  const { todayStartUtc, todayEndUtc, upcomingEndUtc } = sastDayWindows(now);
  const overdue:  T[] = [];
  const today:    T[] = [];
  const upcoming: T[] = [];
  for (const r of rows) {
    if (!r.next_follow_up_at) continue;
    // Terminal stages get no bucketing (a "lost" lead shouldn't appear as overdue)
    if (r.stage && TERMINAL_STAGES.has(r.stage)) continue;
    // Nurture is deliberately paused — it's driven by nurture_wake_at
    // (see bucketWakingToday below), not next_follow_up_at, which may
    // still carry a stale value from before the lead entered nurture.
    // Without this, every nurtured lead would show as overdue.
    if (r.stage === 'nurture') continue;
    const d = new Date(r.next_follow_up_at);
    if (Number.isNaN(d.getTime())) continue;
    if (d < todayStartUtc)         overdue.push(r);
    else if (d < todayEndUtc)      today.push(r);
    else if (d < upcomingEndUtc)   upcoming.push(r);
  }
  // Chronological within each bucket
  const asc = (a: T, b: T) => a.next_follow_up_at!.localeCompare(b.next_follow_up_at!);
  overdue.sort(asc); today.sort(asc); upcoming.sort(asc);
  return { overdue, today, upcoming };
}

/**
 * Whether a lead in a non-terminal stage lacks a next action — used to
 * drive the soft "nudge" (never a hard block) that follow-ups should
 * always be scheduled.
 */
export function isMissingNextAction(row: { stage: string; next_follow_up_at: string | null }): boolean {
  if (TERMINAL_STAGES.has(row.stage)) return false;
  if (row.stage === 'nurture') return false;
  return !row.next_follow_up_at;
}

export type NurtureRow = {
  id: string;
  stage: string;
  nurture_wake_at: string | null;  // ISO
};

/**
 * Nurture leads whose wake date has arrived — today or earlier, so a
 * lead the rep hasn't acted on keeps showing rather than disappearing
 * after its one day. Distinct from bucketFollowups: nurture is
 * excluded there entirely and surfaced here instead, on its own
 * wake-date signal.
 */
export function bucketWakingToday<T extends NurtureRow>(rows: T[], now: Date): T[] {
  const { todayEndUtc } = sastDayWindows(now);
  const waking = rows.filter(r => {
    if (r.stage !== 'nurture' || !r.nurture_wake_at) return false;
    const d = new Date(r.nurture_wake_at);
    if (Number.isNaN(d.getTime())) return false;
    return d < todayEndUtc;
  });
  return waking.sort((a, b) => a.nurture_wake_at!.localeCompare(b.nurture_wake_at!));
}
