// ─── Single source of truth for an instalment's status ──────────────────
//
// Every patient surface that shows whether a payment is paid, coming, or
// LATE derives it here — never from the raw stored `status` alone. The bug
// this closes: a row stored `scheduled` whose due date has passed was
// badged "Upcoming" on the schedule while the home hero said "20 days ago"
// and the Plans header said "nothing overdue". Three screens, three answers,
// all wrong. Lateness is a fact about (due date vs today), so it is computed
// in one place and read everywhere.
//
// Rule: overdue = the money is still owed AND its due date is in the past.
// A `failed`/`defaulted` charge is in arrears by definition (regardless of
// any scheduled retry date), so it is always overdue.

export type InstalmentStatus =
  | 'paid'         // collected
  | 'processing'   // a charge is mid-flight
  | 'overdue'      // owed and past due (incl. failed / defaulted)
  | 'due_today'    // owed and due today
  | 'upcoming'     // owed and due in the future
  | 'written_off'; // no longer owed (absorbed)

export type InstalmentForStatus = {
  status: string;
  due_date: string;                 // YYYY-MM-DD
  next_attempt_date?: string | null;
};

/** Midnight-UTC epoch for a YYYY-MM-DD(...) string — date-only, tz-safe. */
function ymdToUTC(dateStr: string): number {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole-day difference `target - today` on YYYY-MM-DD strings. */
function dayDelta(today: string, target: string): number {
  return Math.round((ymdToUTC(target) - ymdToUTC(today)) / 86_400_000);
}

/**
 * Derive the display status of one instalment as of `today` (a SAST
 * YYYY-MM-DD string — see `todaySAST()`).
 *
 *   collected                 → paid
 *   written_off               → written_off
 *   processing                → processing
 *   failed | defaulted        → overdue (in arrears by definition)
 *   scheduled | retried | …   → overdue  (due date < today)
 *                               due_today (due date == today)
 *                               upcoming  (due date  > today)
 */
export function deriveInstalmentStatus(inst: InstalmentForStatus, today: string): InstalmentStatus {
  switch (inst.status) {
    case 'collected':   return 'paid';
    case 'written_off': return 'written_off';
    case 'processing':  return 'processing';
  }
  // Everything else is money still owed. A failed/defaulted charge is late
  // no matter what a retry date says.
  if (inst.status === 'failed' || inst.status === 'defaulted') return 'overdue';
  // Lateness for a still-scheduled charge is derived from its due date,
  // never trusted from the stored status.
  const delta = dayDelta(today, inst.due_date);
  if (delta < 0)   return 'overdue';
  if (delta === 0) return 'due_today';
  return 'upcoming';
}

/** True iff the instalment is money owed and past its due date. */
export function isInstalmentOverdue(inst: InstalmentForStatus, today: string): boolean {
  return deriveInstalmentStatus(inst, today) === 'overdue';
}

// ─── Shared presentation ─────────────────────────────────────────────────
//
// Labels and semantic tone are single-sourced so a badge on the white sheet
// and a chip on the navy hero always agree on the words and the meaning.
// Each surface maps the tone to its own palette (light vs dark).

export type StatusTone = 'positive' | 'progress' | 'neutral' | 'danger';

const META: Record<InstalmentStatus, { label: string; tone: StatusTone }> = {
  paid:        { label: 'Paid',        tone: 'positive' },
  processing:  { label: 'Processing',  tone: 'progress' },
  due_today:   { label: 'Due today',   tone: 'progress' },
  upcoming:    { label: 'Upcoming',    tone: 'neutral' },
  overdue:     { label: 'Overdue',     tone: 'danger' },
  written_off: { label: 'Written off', tone: 'neutral' },
};

export function instalmentStatusLabel(s: InstalmentStatus): string {
  return META[s].label;
}

export function instalmentStatusTone(s: InstalmentStatus): StatusTone {
  return META[s].tone;
}
