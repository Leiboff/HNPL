/**
 * Single source of truth for the days of the month a patient is allowed to
 * choose as their salary date. Used by the signup form, the patient-portal
 * calendar, and the server-side validators that gate writes to
 * `profiles.salary_day`.
 *
 * Existing patients whose stored `salary_day` falls OUTSIDE this set are
 * grandfathered — their value remains valid and is honoured by the
 * scheduler. The restriction applies only to new writes.
 *
 * If you ever need to add/remove days, change this one constant; everything
 * else picks it up.
 */
export const ALLOWED_SALARY_DAYS = [1, 15, 20, 25, 26, 27, 28, 29, 30, 31] as const;

export type AllowedSalaryDay = (typeof ALLOWED_SALARY_DAYS)[number];

/** True iff `day` is a member of {@link ALLOWED_SALARY_DAYS}. */
export function isAllowedSalaryDay(day: unknown): day is AllowedSalaryDay {
  return (
    typeof day === 'number' &&
    Number.isInteger(day) &&
    (ALLOWED_SALARY_DAYS as readonly number[]).includes(day)
  );
}

// ─── Month-end clamping ──────────────────────────────────────────────────────
//
// Days 29/30/31 don't exist in every month. The scheduler in lib/finance.ts
// uses `clampSalaryDateForMonth` to land a payment on the last valid day of
// short months (e.g. salary day 31 in Feb → Feb 28 or 29). These helpers
// live here so any future surface that displays a "next charge date" can
// reuse the same logic without re-implementing the clamp inline.

/**
 * Last calendar day of the given month, in UTC. `month` is 0-indexed
 * (January = 0) to match `Date`'s convention.
 */
export function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of month+1 == last day of month, courtesy of JS Date overflow.
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * UTC-midnight Date for the given salary day in the given month, clamped to
 * the month's last calendar day when necessary.
 *
 * @param year   four-digit year
 * @param month  0-indexed month (January = 0)
 * @param salaryDay 1..31. Values above the month's last day clamp down to
 *                  the last day; values below 1 are not validated here —
 *                  validate at the input boundary with `isAllowedSalaryDay`.
 */
export function clampSalaryDateForMonth(year: number, month: number, salaryDay: number): Date {
  const clamped = Math.min(salaryDay, lastDayOfMonth(year, month));
  // UTC construction so .toISOString().split('T')[0] yields the correct
  // calendar day regardless of server timezone. Local midnight on UTC+2
  // would serialise to the previous UTC day, landing instalments one day
  // early.
  return new Date(Date.UTC(year, month, clamped));
}

/**
 * The next strictly-future occurrence of `salaryDay`, relative to `now`.
 * If today's date in UTC is the same as or past the clamped salary day for
 * the current month, we advance to next month. Used by the live "Next
 * collection: …" line beneath the salary-day picker.
 *
 * Display-only — the scheduler computes the actual instalment dates via
 * `calculatePaymentDates` in finance.ts (which applies a buffer).
 */
export function nextCollectionDate(salaryDay: number, now: Date = new Date()): Date {
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const today = now.getUTCDate();

  const thisMonth = clampSalaryDateForMonth(year, month, salaryDay);
  if (thisMonth.getUTCDate() <= today) {
    const nextMonth = month === 11 ? 0       : month + 1;
    const nextYear  = month === 11 ? year + 1 : year;
    return clampSalaryDateForMonth(nextYear, nextMonth, salaryDay);
  }
  return thisMonth;
}
