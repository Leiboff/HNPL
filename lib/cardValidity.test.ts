import { describe, it, expect } from 'vitest';
import { lastDayOfMonth, cardExpiryDate, isCardValidForPlan } from './cardValidity';

// ─── lastDayOfMonth ───────────────────────────────────────────────────────────

describe('lastDayOfMonth', () => {
  it('returns 30 Jun 2026 at end-of-day', () => {
    const d = lastDayOfMonth(2026, 6);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5); // 0-indexed
    expect(d.getDate()).toBe(30);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
  });

  it('returns 28 Feb 2025 (non-leap year)', () => {
    const d = lastDayOfMonth(2025, 2);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(1);
    expect(d.getDate()).toBe(28);
  });

  it('returns 29 Feb 2024 (leap year)', () => {
    const d = lastDayOfMonth(2024, 2);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(1);
    expect(d.getDate()).toBe(29);
  });

  it('returns 31 Dec 2026', () => {
    const d = lastDayOfMonth(2026, 12);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(31);
  });

  it('returns 31 Jan 2026', () => {
    const d = lastDayOfMonth(2026, 1);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(31);
  });
});

// ─── cardExpiryDate ───────────────────────────────────────────────────────────

describe('cardExpiryDate', () => {
  it('06/2026 → 30 Jun 2026 at end-of-day', () => {
    const d = cardExpiryDate(6, 2026);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(30);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
  });

  it('12/2028 → 31 Dec 2028 at end-of-day', () => {
    const d = cardExpiryDate(12, 2028);
    expect(d.getFullYear()).toBe(2028);
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(31);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
  });
});

// ─── isCardValidForPlan — 30-day buffer (default) ────────────────────────────

describe('isCardValidForPlan — 30-day buffer', () => {
  // 25 Aug 2026 at midnight local time
  const aug25 = new Date(2026, 7, 25);

  it('card 12/2026 → valid (expires 31 Dec, deadline 24 Sep)', () => {
    expect(isCardValidForPlan({ exp_month: 12, exp_year: 2026 }, aug25)).toBe(true);
  });

  it('card 09/2026 → valid (expires 30 Sep 23:59:59, deadline 24 Sep)', () => {
    // 30 Sep 23:59:59.999 > 24 Sep → passes by 6 days
    expect(isCardValidForPlan({ exp_month: 9, exp_year: 2026 }, aug25)).toBe(true);
  });

  it('card 08/2026 → invalid (expires 31 Aug, deadline 24 Sep)', () => {
    expect(isCardValidForPlan({ exp_month: 8, exp_year: 2026 }, aug25)).toBe(false);
  });

  it('card 12/2026, last instalment 31 Dec 2026 → invalid (no buffer room)', () => {
    // expiry = 31 Dec 2026 23:59:59.999, deadline = 31 Dec + 30 days = 30 Jan 2027
    const dec31 = new Date(2026, 11, 31);
    expect(isCardValidForPlan({ exp_month: 12, exp_year: 2026 }, dec31)).toBe(false);
  });
});

// ─── isCardValidForPlan — 0-day buffer ───────────────────────────────────────

describe('isCardValidForPlan — 0-day buffer', () => {
  const aug25 = new Date(2026, 7, 25);

  it('card 09/2026 → valid (expires 30 Sep, instalment 25 Aug)', () => {
    expect(isCardValidForPlan({ exp_month: 9, exp_year: 2026 }, aug25, 0)).toBe(true);
  });

  it('card 08/2026 → valid (expires end of 31 Aug, instalment 25 Aug)', () => {
    // 31 Aug 23:59:59.999 >= 25 Aug midnight → valid
    expect(isCardValidForPlan({ exp_month: 8, exp_year: 2026 }, aug25, 0)).toBe(true);
  });

  it('card 07/2026 → invalid (expires 31 Jul, instalment 25 Aug)', () => {
    expect(isCardValidForPlan({ exp_month: 7, exp_year: 2026 }, aug25, 0)).toBe(false);
  });
});
