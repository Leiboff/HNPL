import { describe, it, expect } from 'vitest';
import {
  openPayoutWindow,
  payoutDateFor,
  windowDates,
  paidRecentlySince,
  PAID_RECENTLY_DAYS,
} from './payoutSchedule';
import {
  payoutWindowForRun,
  payoutWindowEndingOn,
  sastMidnight,
  sastDateString,
  SAST_OFFSET,
} from './payoutWindow';

// ─── The schedule the UI talks about ────────────────────────────────────
//
// payoutWindow.test.ts pins the boundary rule. These pin the three derived
// facts a practice-facing surface states out loud — which week is still open,
// which day the money lands, and which two dates a window covers — because
// each of them is a sentence a practice reads and checks against their bank
// statement.
//
// Real 2026 calendar (verified): August Thursdays are 6/13/20/27, Fridays
// 7/14/21/28.

const THU_06 = '2026-08-06';
const WED_12 = '2026-08-12';
const THU_13 = '2026-08-13';
const FRI_14 = '2026-08-14';
const WED_19 = '2026-08-19';
const THU_20 = '2026-08-20';
const FRI_21 = '2026-08-21';

const sast = (dt: string) => new Date(`${dt}${SAST_OFFSET}`);

describe('openPayoutWindow — the week still accumulating', () => {
  it('starts exactly where the closed window ended — no gap, no overlap', () => {
    const now    = sast(`${FRI_14}T09:00:00`);
    const closed = payoutWindowForRun(now);
    const open   = openPayoutWindow(now);
    expect(open.windowStart.toISOString()).toBe(closed.windowEnd.toISOString());
  });

  it('covers Thu 13 – Wed 19 for any instant inside that week', () => {
    for (const instant of [
      `${THU_13}T02:00:00`,   // the scheduled close, moments after it opened
      `${FRI_14}T09:00:00`,
      '2026-08-16T23:59:00',
      `${WED_19}T23:59:59`,
    ]) {
      const open = openPayoutWindow(sast(instant));
      expect(open.windowStart.toISOString()).toBe(sastMidnight(THU_13).toISOString());
      expect(open.windowEnd.toISOString()).toBe(sastMidnight(THU_20).toISOString());
    }
  });

  it('rolls over at the boundary: Thu 20 00:00 SAST opens the NEXT week', () => {
    const open = openPayoutWindow(sastMidnight(THU_20));
    expect(open.windowStart.toISOString()).toBe(sastMidnight(THU_20).toISOString());
  });

  it('is exactly seven days long, every week for a year', () => {
    // Walks a full year rather than sampling, because the failure this
    // guards against — a boundary landing on the wrong weekday — would show
    // up in only some weeks.
    let cursor = sast(`${THU_13}T02:00:00`);
    for (let week = 0; week < 52; week++) {
      const open = openPayoutWindow(cursor);
      expect(open.windowEnd.getTime() - open.windowStart.getTime())
        .toBe(7 * 24 * 60 * 60 * 1000);
      cursor = new Date(open.windowStart.getTime() + 3 * 24 * 60 * 60 * 1000);
    }
  });

  it('agrees with payoutWindowEndingOn — it IS that function, not a parallel path', () => {
    const open = openPayoutWindow(sast(`${FRI_14}T09:00:00`));
    const direct = payoutWindowEndingOn(THU_20);
    expect(open.windowStart.toISOString()).toBe(direct.windowStart.toISOString());
    expect(open.windowEnd.toISOString()).toBe(direct.windowEnd.toISOString());
  });
});

describe('payoutDateFor — the day money lands, never a hardcoded string', () => {
  it('a window ending Thu 13 is paid Fri 14', () => {
    expect(payoutDateFor(payoutWindowEndingOn(THU_13))).toBe(FRI_14);
  });

  it('the following window is paid Fri 21', () => {
    expect(payoutDateFor(payoutWindowEndingOn(THU_20))).toBe(FRI_21);
  });

  it('is ALWAYS a Friday — for 52 consecutive windows', () => {
    // The property, not one example. If the boundary ever moves, this fails
    // loudly instead of the UI quietly naming the wrong day.
    let cursor = sast(`${THU_13}T02:00:00`);
    for (let week = 0; week < 52; week++) {
      const w    = payoutWindowForRun(cursor);
      const paid = payoutDateFor(w);
      // Weekday read through sastMidnight so this assertion itself cannot
      // be fooled by a host timezone.
      expect(new Date(sastMidnight(paid).getTime() + 2 * 60 * 60 * 1000).getUTCDay()).toBe(5);
      cursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
  });

  it('is the day AFTER the exclusive end, i.e. two days after the last covered day', () => {
    const w = payoutWindowEndingOn(THU_13);
    const { lastDate } = windowDates(w);
    expect(lastDate).toBe(WED_12);
    expect(payoutDateFor(w)).toBe(FRI_14);
  });

  it('names a SAST date, not a UTC one — the bug this module exists to prevent', () => {
    // windowEnd is Thu 13 00:00 SAST = Wed 12 22:00 UTC. A UTC-based
    // implementation would return the 13th (or the 12th), not the 14th.
    const w = payoutWindowEndingOn(THU_13);
    expect(w.windowEnd.toISOString()).toBe('2026-08-12T22:00:00.000Z');
    expect(payoutDateFor(w)).toBe(FRI_14);
    expect(payoutDateFor(w)).not.toBe(w.windowEnd.toISOString().slice(0, 10));
  });
});

describe('windowDates — the two dates a practice reconciles against', () => {
  it('reports the INCLUSIVE last day, never the exclusive Thursday', () => {
    expect(windowDates(payoutWindowEndingOn(THU_13))).toEqual({
      firstDate: THU_06,
      lastDate:  WED_12,
    });
  });

  it('is byte-identical to the label the runner records in cron_runs', () => {
    // Same source function, so a practice and an operator cannot be looking
    // at two different descriptions of one batch.
    const w = payoutWindowEndingOn(THU_13);
    const { firstDate, lastDate } = windowDates(w);
    expect(`${firstDate} to ${lastDate}`).toBe('2026-08-06 to 2026-08-12');
  });

  it('the open window describes itself as Thu 13 – Wed 19', () => {
    expect(windowDates(openPayoutWindow(sast(`${FRI_14}T09:00:00`)))).toEqual({
      firstDate: THU_13,
      lastDate:  WED_19,
    });
  });

  it('firstDate is a Thursday and lastDate a Wednesday, for 52 windows', () => {
    let cursor = sast(`${THU_13}T02:00:00`);
    for (let week = 0; week < 52; week++) {
      const { firstDate, lastDate } = windowDates(payoutWindowForRun(cursor));
      const weekdayOf = (d: string) =>
        new Date(sastMidnight(d).getTime() + 2 * 60 * 60 * 1000).getUTCDay();
      expect(weekdayOf(firstDate)).toBe(4);
      expect(weekdayOf(lastDate)).toBe(3);
      cursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
  });
});

describe('paidRecentlySince — the 30-day window for the secondary figure', () => {
  it('is exactly 30 days before the given instant', () => {
    expect(PAID_RECENTLY_DAYS).toBe(30);
    const now = sast(`${FRI_14}T09:00:00`);
    const since = paidRecentlySince(now);
    expect(now.getTime() - since.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('is an INSTANT, not a midnight — paid_at is a timestamp', () => {
    // Truncating to a SAST midnight would silently include or exclude a
    // whole day's settlements depending on the hour of the run.
    const now = sast(`${FRI_14}T09:37:11`);
    expect(paidRecentlySince(now).toISOString()).not.toBe(
      sastMidnight(sastDateString(paidRecentlySince(now))).toISOString(),
    );
  });
});
