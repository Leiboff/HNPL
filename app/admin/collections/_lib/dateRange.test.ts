import { describe, it, expect } from 'vitest';
import {
  addDaysStr,
  startOfMonth,
  endOfMonth,
  defaultRangeForChip,
  parseRangeParams,
  formatPeriodLabel,
} from './dateRange';

// ─── Collections date-range helpers — pin the contract ─────────────────────
//
// These tests lock the URL-resolution + label-formatting rules so the
// page header reads consistently and the chip-defaults don't drift.

const TODAY      = '2026-06-15';
const MONTH_END  = '2026-06-30';
const MONTH_HEAD = '2026-06-01';

describe('date arithmetic helpers', () => {
  it('addDaysStr handles month boundaries (negative + positive)', () => {
    expect(addDaysStr('2026-06-15', 30)).toBe('2026-07-15');
    expect(addDaysStr('2026-06-15', -30)).toBe('2026-05-16');
    expect(addDaysStr('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysStr('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('addDaysStr handles leap-year February correctly', () => {
    expect(addDaysStr('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDaysStr('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDaysStr('2025-02-28', 1)).toBe('2025-03-01');
  });

  it('startOfMonth + endOfMonth return correct boundaries', () => {
    expect(startOfMonth('2026-06-15')).toBe('2026-06-01');
    expect(endOfMonth  ('2026-06-15')).toBe('2026-06-30');
    expect(endOfMonth  ('2026-02-10')).toBe('2026-02-28');
    expect(endOfMonth  ('2024-02-10')).toBe('2024-02-29'); // leap
    expect(endOfMonth  ('2026-12-15')).toBe('2026-12-31');
  });
});

describe('defaultRangeForChip', () => {
  it("'overdue' has no default range — overdue is 'as of now', not windowed", () => {
    expect(defaultRangeForChip('overdue',     TODAY)).toEqual({ from: '', to: '' });
    expect(defaultRangeForChip('processing',  TODAY)).toEqual({ from: '', to: '' });
    expect(defaultRangeForChip('failed',      TODAY)).toEqual({ from: '', to: '' });
    expect(defaultRangeForChip('written_off', TODAY)).toEqual({ from: '', to: '' });
  });

  it("'upcoming' defaults to today → +30 days (operational horizon)", () => {
    expect(defaultRangeForChip('upcoming', TODAY)).toEqual({
      from: TODAY,
      to:   '2026-07-15',
    });
  });

  it("'collected' defaults to month-to-date (start of month → today)", () => {
    expect(defaultRangeForChip('collected', TODAY)).toEqual({
      from: MONTH_HEAD,
      to:   TODAY,
    });
  });

  it("'all' defaults to the full current calendar month", () => {
    expect(defaultRangeForChip('all', TODAY)).toEqual({
      from: MONTH_HEAD,
      to:   MONTH_END,
    });
  });
});

describe('parseRangeParams', () => {
  it('absent params → returns the chip default', () => {
    expect(parseRangeParams({}, 'collected', TODAY)).toEqual({
      from: MONTH_HEAD,
      to:   TODAY,
    });
  });

  it('explicit empty strings → returns empty (user cleared the range)', () => {
    // Distinguishing "absent" from "explicitly empty" lets the Clear
    // button work as a real override — clearing the filter while on
    // Collected (which has a non-empty default) gives all-time.
    expect(parseRangeParams({ from: '', to: '' }, 'collected', TODAY)).toEqual({
      from: '',
      to:   '',
    });
  });

  it('explicit dates → returned as-is', () => {
    expect(parseRangeParams(
      { from: '2026-05-01', to: '2026-05-31' },
      'collected',
      TODAY,
    )).toEqual({ from: '2026-05-01', to: '2026-05-31' });
  });

  it('only `from` present is still explicit (one-sided range)', () => {
    expect(parseRangeParams({ from: '2026-05-01' }, 'collected', TODAY)).toEqual({
      from: '2026-05-01',
      to:   '',
    });
  });
});

describe('formatPeriodLabel — chip-aware header', () => {
  it('no range → bare chip noun', () => {
    expect(formatPeriodLabel('overdue',  '',  '', TODAY)).toBe('Overdue');
    expect(formatPeriodLabel('failed',   '',  '', TODAY)).toBe('Failed / retrying');
    expect(formatPeriodLabel('collected','',  '', TODAY)).toBe('Collected');
  });

  it("month-to-date current month → 'in June'", () => {
    expect(formatPeriodLabel('collected', MONTH_HEAD, TODAY, TODAY))
      .toBe('Collected in June');
  });

  it("exact calendar month → 'in June'", () => {
    expect(formatPeriodLabel('all', MONTH_HEAD, MONTH_END, TODAY))
      .toBe('All in June');
  });

  it("month range in a previous year keeps the year", () => {
    expect(formatPeriodLabel('collected', '2025-05-01', '2025-05-31', TODAY))
      .toBe('Collected in May 2025');
  });

  it("today → +30 → 'next 30 days'", () => {
    expect(formatPeriodLabel('upcoming', TODAY, '2026-07-15', TODAY))
      .toBe('Upcoming, next 30 days');
  });

  it("last 7 days ending today → 'last 7 days'", () => {
    expect(formatPeriodLabel('collected', '2026-06-08', TODAY, TODAY))
      .toBe('Collected, last 7 days');
  });

  it("custom range falls back to '1 May – 15 May' style", () => {
    expect(formatPeriodLabel('overdue', '2026-05-01', '2026-05-15', TODAY))
      .toBe('Overdue, 1 May 2026 – 15 May 2026');
  });

  it('one-sided range (only from) reads cleanly', () => {
    expect(formatPeriodLabel('collected', '2026-05-01', '', TODAY))
      .toBe('Collected, from 1 May 2026');
  });

  it('one-sided range (only to) reads cleanly', () => {
    expect(formatPeriodLabel('upcoming', '', '2026-07-31', TODAY))
      .toBe('Upcoming, to 31 Jul 2026');
  });
});
