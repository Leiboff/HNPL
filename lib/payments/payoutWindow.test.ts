import { describe, it, expect } from 'vitest';
import {
  payoutWindowForRun,
  payoutWindowEndingOn,
  describePayoutWindow,
  sastDateString,
  sastMidnight,
  SAST_OFFSET,
} from './payoutWindow';

// ─── The payout window is the reconcilability guarantee ─────────────────
//
// A practice can only check a weekly deposit against their bank statement if
// the set of plans inside it is bounded by two exact instants. These tests
// pin those instants, including the exact boundary, because an off-by-one
// here doesn't throw — it silently moves someone's money into a different
// week.
//
// Real 2026 calendar (verified, not assumed): 1 Jan 2026 is a Thursday, so
// in August 2026 the Thursdays are the 6th, 13th, 20th, 27th and the
// Fridays are the 7th, 14th, 21st, 28th.
//
// NOTE: the design brief's illustrative copy said "Covers Thu 7 – Wed 13 →
// Friday 14 Aug". 7 Aug 2026 is a FRIDAY, so those sample dates are not a
// real 2026 week and are deliberately not used as fixtures here. What is
// pinned is the RULE the brief specifies — Thu→Wed, paid the following
// Friday — which for this real week is Thu 6 → Wed 12, paid Fri 14.

const THU_06 = '2026-08-06';
const WED_12 = '2026-08-12';
const THU_13 = '2026-08-13';
const FRI_14 = '2026-08-14';

/** An instant expressed in SAST wall-clock terms. */
function sast(dateTime: string): Date {
  return new Date(`${dateTime}${SAST_OFFSET}`);
}

describe('SAST is handled by explicit offset, never by host local time', () => {
  it('SAST_OFFSET is +02:00 — no DST, so a fixed offset is correct not lazy', () => {
    expect(SAST_OFFSET).toBe('+02:00');
  });

  it('sastMidnight builds the UTC instant two hours earlier', () => {
    // 00:00 SAST on the 6th is 22:00 UTC on the 5th. If this ever read the
    // host timezone it would differ between a Vercel box and a SA laptop.
    expect(sastMidnight(THU_06).toISOString()).toBe('2026-08-05T22:00:00.000Z');
  });

  it('sastDateString reports the SAST calendar day, not the UTC one', () => {
    // 23:30 UTC on the 5th is already 01:30 on the 6th in SAST.
    expect(sastDateString(new Date('2026-08-05T23:30:00.000Z'))).toBe('2026-08-06');
    // And the reverse: 21:00 UTC on the 5th is still the 5th in SAST.
    expect(sastDateString(new Date('2026-08-05T21:00:00.000Z'))).toBe('2026-08-05');
  });

  it('rejects a malformed date rather than producing an Invalid Date window', () => {
    expect(() => sastMidnight('not-a-date')).toThrow(/not a valid/);
  });
});

describe('a Friday run settles Thursday → Wednesday', () => {
  const w = payoutWindowForRun(sast(`${FRI_14}T06:00:00`));

  it('starts Thursday 00:00 SAST', () => {
    expect(w.windowStart.toISOString()).toBe(sastMidnight(THU_06).toISOString());
  });

  it('ends at the NEXT Thursday 00:00 SAST, exclusive', () => {
    expect(w.windowEnd.toISOString()).toBe(sastMidnight(THU_13).toISOString());
  });

  it('is exactly seven days long', () => {
    expect(w.windowEnd.getTime() - w.windowStart.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('describes itself with an INCLUSIVE end date — never the exclusive Thursday', () => {
    // Showing "to 2026-08-13" would read as an extra day of cover.
    expect(describePayoutWindow(w)).toBe(`${THU_06} to ${WED_12}`);
  });
});

describe('the boundary is exact', () => {
  const w = payoutWindowForRun(sast(`${FRI_14}T06:00:00`));
  const inWindow = (instant: Date) =>
    instant.getTime() >= w.windowStart.getTime() && instant.getTime() < w.windowEnd.getTime();

  it('THE FIRST INSTANT: Thursday 00:00:00.000 SAST is IN', () => {
    expect(inWindow(sast(`${THU_06}T00:00:00.000`))).toBe(true);
  });

  it('one millisecond earlier is in the PREVIOUS window', () => {
    expect(inWindow(new Date(sastMidnight(THU_06).getTime() - 1))).toBe(false);
  });

  it('THE LAST INSTANT: Wednesday 23:59:59.999 SAST is IN', () => {
    expect(inWindow(sast(`${WED_12}T23:59:59.999`))).toBe(true);
  });

  it('Wednesday 23:59:59 SAST is IN (the brief\'s stated cut-off)', () => {
    expect(inWindow(sast(`${WED_12}T23:59:59`))).toBe(true);
  });

  it('Thursday 00:00:01 SAST is OUT — it belongs to the NEXT batch', () => {
    expect(inWindow(sast(`${THU_13}T00:00:01`))).toBe(false);
  });

  it('Thursday 00:00:00 SAST exactly is OUT — half-open, so no millisecond reasoning', () => {
    expect(inWindow(sast(`${THU_13}T00:00:00.000`))).toBe(false);
  });

  it('a Wednesday-AFTERNOON activation is in — the reason the cut-off is not 11:00', () => {
    // collect-instalments runs 11:00 UTC = 13:00 SAST. A cut-off aligned to
    // it would push this activation into the following week: an eight-day
    // wait a practice would read as a missing payout.
    expect(inWindow(sast(`${WED_12}T15:30:00`))).toBe(true);
  });
});

describe('the settlement buffer the UI has to state', () => {
  const w = payoutWindowForRun(sast(`${FRI_14}T06:00:00`));

  it('a Wednesday activation pays out two days later', () => {
    expect(sast(`${WED_12}T10:00:00`).getTime()).toBeLessThan(w.windowEnd.getTime());
    // Paid on Friday the 14th: Wed 12 → Fri 14 is two days.
  });

  it('a Thursday activation waits eight days — it misses this window', () => {
    const thursdayActivation = sast(`${THU_13}T10:00:00`);
    expect(thursdayActivation.getTime()).toBeGreaterThanOrEqual(w.windowEnd.getTime());
    // It lands in the window ending Thu 20, paid Friday the 21st.
    const next = payoutWindowForRun(sast('2026-08-21T06:00:00'));
    expect(thursdayActivation.getTime()).toBeGreaterThanOrEqual(next.windowStart.getTime());
    expect(thursdayActivation.getTime()).toBeLessThan(next.windowEnd.getTime());
  });
});

describe('re-running resolves the SAME window — which is what makes it safe', () => {
  const friday = payoutWindowForRun(sast(`${FRI_14}T06:00:00`));

  it.each([
    ['later the same Friday', `${FRI_14}T23:00:00`],
    ['Saturday',              '2026-08-15T09:00:00'],
    ['Sunday night',          '2026-08-16T23:59:00'],
    ['Wednesday the 19th',    '2026-08-19T12:00:00'],
  ])('%s resolves to the same window', (_label, instant) => {
    const w = payoutWindowForRun(sast(instant));
    expect(w.windowStart.toISOString()).toBe(friday.windowStart.toISOString());
    expect(w.windowEnd.toISOString()).toBe(friday.windowEnd.toISOString());
  });

  it('but the NEXT Thursday opens a new window', () => {
    const w = payoutWindowForRun(sast('2026-08-20T09:00:00'));
    expect(w.windowStart.toISOString()).toBe(sastMidnight(THU_13).toISOString());
    expect(w.windowEnd.toISOString()).toBe(sastMidnight('2026-08-20').toISOString());
  });
});

describe('running exactly ON the boundary does not skip a week', () => {
  it('at Thursday 00:00:00 SAST it settles the week that JUST closed', () => {
    // The first version of this function required the boundary to be
    // STRICTLY before the run, which silently skipped this whole week.
    const w = payoutWindowForRun(sastMidnight(THU_13));
    expect(w.windowStart.toISOString()).toBe(sastMidnight(THU_06).toISOString());
    expect(w.windowEnd.toISOString()).toBe(sastMidnight(THU_13).toISOString());
  });

  it('a Thursday-afternoon run settles the week that closed that morning', () => {
    const w = payoutWindowForRun(sast(`${THU_13}T14:00:00`));
    expect(describePayoutWindow(w)).toBe(`${THU_06} to ${WED_12}`);
  });

  it('consecutive weeks abut exactly — no gap, no overlap', () => {
    const a = payoutWindowForRun(sast(`${FRI_14}T06:00:00`));
    const b = payoutWindowForRun(sast('2026-08-21T06:00:00'));
    expect(b.windowStart.toISOString()).toBe(a.windowEnd.toISOString());
  });
});

describe('backfill for a missed Friday', () => {
  it('takes the exclusive Thursday end and reproduces that exact window', () => {
    const w = payoutWindowEndingOn(THU_13);
    expect(describePayoutWindow(w)).toBe(`${THU_06} to ${WED_12}`);
    expect(w.windowEnd.toISOString()).toBe(sastMidnight(THU_13).toISOString());
  });

  it('matches what the normal Friday run would have produced', () => {
    const normal   = payoutWindowForRun(sast(`${FRI_14}T06:00:00`));
    const backfill = payoutWindowEndingOn(THU_13);
    expect(backfill.windowStart.toISOString()).toBe(normal.windowStart.toISOString());
    expect(backfill.windowEnd.toISOString()).toBe(normal.windowEnd.toISOString());
  });

  it.each([
    ['a Friday',    FRI_14],
    ['a Wednesday', WED_12],
    ['a Monday',    '2026-08-10'],
  ])('REFUSES %s — a non-Thursday boundary would overlap the neighbouring batches', (_l, date) => {
    expect(() => payoutWindowEndingOn(date)).toThrow(/not a Thursday/);
  });
});
