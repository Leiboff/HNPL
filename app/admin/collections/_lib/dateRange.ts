// ─── Collections date-range helpers ─────────────────────────────────────────
//
// All pure functions; tested in isolation in [[dateRange-test]]. They
// drive three things on /admin/collections:
//
//   1. parseRangeParams(params, chip, today)
//        Resolves the URL's from/to to a concrete { from, to } pair.
//        If from/to are absent entirely → returns the chip's default.
//        If from/to are present but empty → returns { from: '', to: '' }
//        (the explicit "no range / all time" state).
//
//   2. defaultRangeForChip(chip, today)
//        Sensible operational default per chip. Forward-looking chips
//        (Upcoming, All) lean future / current-month; backward-looking
//        chips (Collected) lean current-month; "as-of-now" chips
//        (Overdue, Awaiting, Failed, Written off) use no range — they
//        are concepts about state, not a window. Picking a range on
//        those chips still works (interpreted as "items whose due_date
//        falls in the range") — see formatPeriodLabel for how the
//        header makes that legible.
//
//   3. formatPeriodLabel(chip, from, to, today)
//        Chip-aware header summary line: "Collected in June", "Upcoming,
//        next 30 days", "Overdue" — never an ambiguous bare total.

export type ChipKey =
  | 'overdue'
  | 'upcoming'
  | 'processing'
  | 'failed'
  | 'defaulted'
  | 'collected'
  | 'written_off'
  | 'all';

export type DateRange = { from: string; to: string };  // YYYY-MM-DD or ''

const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;
const LONG_MONTHS  = ['January','February','March','April','May','June','July','August','September','October','November','December'] as const;

function pad(n: number): string { return String(n).padStart(2, '0'); }

export function addDaysStr(yyyymmdd: string, days: number): string {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function startOfMonth(yyyymmdd: string): string {
  const [y, m] = yyyymmdd.split('-');
  return `${y}-${m}-01`;
}

export function endOfMonth(yyyymmdd: string): string {
  const [y, m] = yyyymmdd.split('-').map(Number);
  // Day 0 of next month = last day of this month.
  const dt = new Date(Date.UTC(y, m, 0));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// Is the range from `from` to `to` exactly the calendar month containing `from`?
function isExactCalendarMonth(from: string, to: string): boolean {
  if (!from || !to) return false;
  if (from !== startOfMonth(from)) return false;
  return to === endOfMonth(from);
}

// Is the range an "open" month-to-date (start of month → today)?
function isMonthToDate(from: string, to: string, today: string): boolean {
  if (!from || !to) return false;
  return from === startOfMonth(today) && to === today;
}

// Is the range "next N days from today"?
function isNextNDays(from: string, to: string, today: string, n: number): boolean {
  if (!from || !to) return false;
  return from === today && to === addDaysStr(today, n);
}

// Is the range "last N days ending today"?
function isLastNDays(from: string, to: string, today: string, n: number): boolean {
  if (!from || !to) return false;
  return to === today && from === addDaysStr(today, -n);
}

function formatYMD(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split('-');
  return `${parseInt(d, 10)} ${SHORT_MONTHS[parseInt(m, 10) - 1]} ${y}`;
}

function monthNameOf(yyyymmdd: string, today: string): string {
  const [y, m] = yyyymmdd.split('-').map(Number);
  const tYear  = parseInt(today.split('-')[0], 10);
  // Drop the year when the month is in the current year to keep the
  // header tight ("Collected in June" rather than "Collected in June 2026").
  return y === tYear ? LONG_MONTHS[m - 1] : `${LONG_MONTHS[m - 1]} ${y}`;
}

// ─── Default range per chip ─────────────────────────────────────────────────

export function defaultRangeForChip(chip: ChipKey, today: string): DateRange {
  switch (chip) {
    case 'overdue':
    case 'processing':
    case 'failed':
    case 'defaulted':
    case 'written_off':
      // "Status" chips — concept is "as of now", not a time window.
      // Default to all-time so the user sees every open item.
      return { from: '', to: '' };

    case 'upcoming':
      // Forward-looking; 30 days is the natural operational horizon
      // (matches the dashboard's "next 30 days" mental model).
      return { from: today, to: addDaysStr(today, 30) };

    case 'collected':
      // Backward-looking activity in the current month.
      return { from: startOfMonth(today), to: today };

    case 'all':
      // Mixed — the current month gives a balanced view of what was
      // due and what came in.
      return { from: startOfMonth(today), to: endOfMonth(today) };
  }
}

// ─── Parse URL params into a concrete range ─────────────────────────────────

export function parseRangeParams(
  params: { from?: string; to?: string },
  chip:   ChipKey,
  today:  string,
): DateRange {
  // If either param is present in the URL (even as empty string) the
  // user has expressed an explicit choice; honor it. Otherwise apply
  // the chip's default.
  const explicit = params.from !== undefined || params.to !== undefined;
  if (explicit) {
    return { from: params.from ?? '', to: params.to ?? '' };
  }
  return defaultRangeForChip(chip, today);
}

// ─── Chip-aware period label ────────────────────────────────────────────────
//
// Produces strings like:
//   "Collected in June"           (this-month range on Collected)
//   "Upcoming, next 30 days"      (today→+30 on Upcoming)
//   "Overdue"                     (no range)
//   "All in June"                 (this-month range on All)
//   "Collected, 1 May – 31 May"   (custom range)

const CHIP_NOUN: Record<ChipKey, string> = {
  overdue:     'Overdue',
  upcoming:    'Upcoming',
  processing:  'Awaiting',
  failed:      'Failed / retrying',
  defaulted:   'Defaulted',
  collected:   'Collected',
  written_off: 'Written off',
  all:         'All',
};

export function formatPeriodLabel(chip: ChipKey, from: string, to: string, today: string): string {
  const noun = CHIP_NOUN[chip];

  if (!from && !to) return noun;

  if (isMonthToDate(from, to, today) || isExactCalendarMonth(from, to)) {
    // Prefer the natural "in <Month>" framing for whole or partial-month
    // ranges of the current month.
    return `${noun} in ${monthNameOf(from, today)}`;
  }

  if (isNextNDays(from, to, today, 30)) return `${noun}, next 30 days`;
  if (isNextNDays(from, to, today, 7))  return `${noun}, next 7 days`;
  if (isLastNDays(from, to, today, 30)) return `${noun}, last 30 days`;
  if (isLastNDays(from, to, today, 7))  return `${noun}, last 7 days`;

  if (from && to) return `${noun}, ${formatYMD(from)} – ${formatYMD(to)}`;
  if (from)       return `${noun}, from ${formatYMD(from)}`;
  return `${noun}, to ${formatYMD(to)}`;
}
