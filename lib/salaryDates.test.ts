import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALLOWED_SALARY_DAYS,
  isAllowedSalaryDay,
  lastDayOfMonth,
  clampSalaryDateForMonth,
} from './salaryDates';

// ─── isAllowedSalaryDay ─────────────────────────────────────────────────────

describe('isAllowedSalaryDay', () => {
  it.each(ALLOWED_SALARY_DAYS)('accepts %i (member of the allowed set)', (d) => {
    expect(isAllowedSalaryDay(d)).toBe(true);
  });

  const rejected = [-1, 0, 2, 3, 5, 10, 14, 16, 19, 21, 24, 32, 100];
  it.each(rejected)('rejects %i (outside the allowed set)', (d) => {
    expect(isAllowedSalaryDay(d)).toBe(false);
  });

  it('rejects fractional numbers', () => {
    expect(isAllowedSalaryDay(25.5)).toBe(false);
    expect(isAllowedSalaryDay(1.0001)).toBe(false);
  });

  it('rejects non-numbers', () => {
    expect(isAllowedSalaryDay('25')).toBe(false);
    expect(isAllowedSalaryDay(null)).toBe(false);
    expect(isAllowedSalaryDay(undefined)).toBe(false);
    expect(isAllowedSalaryDay({})).toBe(false);
    expect(isAllowedSalaryDay(NaN)).toBe(false);
  });
});

// ─── lastDayOfMonth ─────────────────────────────────────────────────────────

describe('lastDayOfMonth', () => {
  it('January = 31', () => {
    expect(lastDayOfMonth(2025, 0)).toBe(31);
  });

  it('February 2025 (non-leap) = 28', () => {
    expect(lastDayOfMonth(2025, 1)).toBe(28);
  });

  it('February 2024 (leap year) = 29', () => {
    expect(lastDayOfMonth(2024, 1)).toBe(29);
  });

  it('February 2000 (divisible-by-400 century → leap) = 29', () => {
    expect(lastDayOfMonth(2000, 1)).toBe(29);
  });

  it('February 1900 (divisible-by-100 not 400 → non-leap) = 28', () => {
    expect(lastDayOfMonth(1900, 1)).toBe(28);
  });

  it('April = 30', () => {
    expect(lastDayOfMonth(2025, 3)).toBe(30);
  });

  it('December = 31', () => {
    expect(lastDayOfMonth(2025, 11)).toBe(31);
  });
});

// ─── clampSalaryDateForMonth ────────────────────────────────────────────────

describe('clampSalaryDateForMonth', () => {
  it('salary day 31 in Feb 2025 (non-leap) clamps to Feb 28', () => {
    expect(clampSalaryDateForMonth(2025, 1, 31).toISOString().slice(0, 10)).toBe('2025-02-28');
  });

  it('salary day 31 in Feb 2024 (leap) clamps to Feb 29', () => {
    expect(clampSalaryDateForMonth(2024, 1, 31).toISOString().slice(0, 10)).toBe('2024-02-29');
  });

  it('salary day 30 in Feb 2025 (non-leap) clamps to Feb 28', () => {
    expect(clampSalaryDateForMonth(2025, 1, 30).toISOString().slice(0, 10)).toBe('2025-02-28');
  });

  it('salary day 29 in Feb 2025 (non-leap) clamps to Feb 28', () => {
    expect(clampSalaryDateForMonth(2025, 1, 29).toISOString().slice(0, 10)).toBe('2025-02-28');
  });

  it('salary day 29 in Feb 2024 (leap) stays on Feb 29', () => {
    expect(clampSalaryDateForMonth(2024, 1, 29).toISOString().slice(0, 10)).toBe('2024-02-29');
  });

  it('salary day 31 in April clamps to April 30', () => {
    expect(clampSalaryDateForMonth(2025, 3, 31).toISOString().slice(0, 10)).toBe('2025-04-30');
  });

  it('salary day 25 in any month is unchanged', () => {
    expect(clampSalaryDateForMonth(2025, 1, 25).toISOString().slice(0, 10)).toBe('2025-02-25');
    expect(clampSalaryDateForMonth(2025, 5, 25).toISOString().slice(0, 10)).toBe('2025-06-25');
  });

  it('returns a UTC-midnight Date', () => {
    const d = clampSalaryDateForMonth(2025, 0, 15);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
    expect(d.getUTCMilliseconds()).toBe(0);
  });
});

// ─── Single-source-of-truth check ───────────────────────────────────────────
//
// Every surface that handles salary-day input must import from
// @/lib/salaryDates rather than copy the canonical set into a local literal.
// If a future contributor pastes [1, 15, 20, 25, ...] inline, this fails.

describe('ALLOWED_SALARY_DAYS is the single source of truth', () => {
  const surfaces = [
    'app/patient/SalaryDayForm.tsx',
    'app/patient/page.tsx',
    'app/signup/patient/PatientSignupForm.tsx',
    'app/signup/patient/actions.ts',
  ];

  it.each(surfaces)('%s depends on the canonical source (lib/salaryDates or the shared picker)', (rel) => {
    const src = readFileSync(resolve(process.cwd(), rel), 'utf8');
    // Acceptable: import directly from lib/salaryDates, OR import the
    // shared SalaryDayPicker which itself imports from lib/salaryDates.
    const importsLib    = /from\s+['"]@\/lib\/salaryDates['"]/.test(src);
    const importsPicker = /from\s+['"]@\/components\/SalaryDayPicker['"]/.test(src);
    expect(importsLib || importsPicker).toBe(true);
  });

  // Reject the canonical tuple as a JS-array literal. Requiring the opening
  // bracket means `ALLOWED_SALARY_DAYS.join(', ')` in error messages won't
  // false-positive (runtime expands to "1, 15, ..." but source doesn't).
  it.each(surfaces)('%s contains no local literal of the canonical allowed set', (rel) => {
    const src = readFileSync(resolve(process.cwd(), rel), 'utf8');
    expect(src).not.toMatch(/\[\s*1\s*,\s*15\s*,\s*20\s*,\s*25/);
  });
});
