// ─── CRM timezone helpers — Africa/Johannesburg ────────────────────────
//
// All CRM follow-up logic runs in Africa/Johannesburg (SAST). SAST has
// no DST — permanent UTC+2 — so we compute the offset explicitly and
// avoid pulling a full IANA lib for a single fixed offset.

export const SAST_OFFSET_MINUTES = 120;
export const SAST_TZ = 'Africa/Johannesburg';

/**
 * Return the Y-M-D "date in SAST" for a given UTC instant.
 * Format: 'YYYY-MM-DD'. Used for bucketing follow-ups into overdue /
 * today / upcoming without pulling a formatter dependency.
 */
export function sastDateStr(date: Date): string {
  const t = date.getTime() + SAST_OFFSET_MINUTES * 60_000;
  const shifted = new Date(t);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Build a UTC Date from a SAST-local date-string (YYYY-MM-DD) and time
 * string (HH:MM). Used by the schedule-call form: user picks a time in
 * their local SA timezone; the form ships it to the server as-is and
 * this converts to UTC before persisting.
 */
export function sastLocalToUtc(dateStr: string, timeStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  // Interpret Y-M-D HH:MM as SAST, then subtract offset to get UTC.
  const asUtc = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  return new Date(asUtc - SAST_OFFSET_MINUTES * 60_000);
}

/**
 * Compute the start-of-day, end-of-day, and end-of-upcoming-window
 * (7 days out) UTC instants for the SAST calendar day that contains
 * `now`. All returned Dates are UTC-referenced.
 */
export function sastDayWindows(now: Date): {
  todayStartUtc:    Date;
  todayEndUtc:      Date;   // start of tomorrow SAST → so a comparison of x < todayEndUtc means "today or earlier today"
  upcomingEndUtc:   Date;   // 7 days beyond today's end
} {
  const today = sastDateStr(now);
  const todayStartUtc = sastLocalToUtc(today, '00:00');
  const [y, m, d] = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + 1));
  const tomorrowStr = sastDateStr(tomorrow);
  const todayEndUtc = sastLocalToUtc(tomorrowStr, '00:00');
  const upcoming = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + 8));
  const upcomingStr = sastDateStr(upcoming);
  const upcomingEndUtc = sastLocalToUtc(upcomingStr, '00:00');
  return { todayStartUtc, todayEndUtc, upcomingEndUtc };
}
