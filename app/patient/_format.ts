// ─── Shared money + date formatting for the v4 patient portal ────────────
//
// One home for the formatters every portal screen used to redeclare
// locally. Currency is always `R1,000.00` (comma thousands, two decimals);
// dates are written the way people say them ("Friday 1 Aug", "1 Aug 2026").
// Pure string math on YYYY-MM-DD keeps everything timezone-safe.

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/** `R1,000.00` — comma thousands, always two decimals. */
export function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

/** `1 Aug 2026`. */
export function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** `1 Aug` — day + month, no year. */
export function formatDayMonth(dateStr: string): string {
  const [, month, day] = dateStr.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

/** `Friday 1 Aug` — weekday + day + month. Deterministic (UTC). */
export function formatWeekdayDayMonth(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[wd]} ${day} ${MONTHS[month - 1]}`;
}

/** Whole-day difference `target - today` (both YYYY-MM-DD), timezone-safe. */
export function daysBetween(fromStr: string, toStr: string): number {
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to   = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

/** Today in SA time as a YYYY-MM-DD string (matches DB date columns). */
export function todaySAST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
}

/**
 * Human "when" for an upcoming/overdue date, relative to today.
 *   0  → "Today"      1 → "Tomorrow"     n>1 → "In n days"
 *   -1 → "Yesterday"  n<-1 → "n days ago"
 */
export function relativeDay(dateStr: string, today = todaySAST()): string {
  const d = daysBetween(today, dateStr);
  if (d === 0)  return 'Today';
  if (d === 1)  return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  return d > 0 ? `In ${d} days` : `${-d} days ago`;
}
