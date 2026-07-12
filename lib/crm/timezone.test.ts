import { describe, it, expect } from 'vitest';
import { sastDateStr, sastLocalToUtc, sastDayWindows } from './timezone';

describe('SAST timezone helpers', () => {
  it('sastDateStr returns YYYY-MM-DD for the SAST calendar day', () => {
    // 2026-06-25 23:30 UTC → 2026-06-26 01:30 SAST
    expect(sastDateStr(new Date('2026-06-25T23:30:00Z'))).toBe('2026-06-26');
    // 2026-06-25 00:00 UTC → 2026-06-25 02:00 SAST
    expect(sastDateStr(new Date('2026-06-25T00:00:00Z'))).toBe('2026-06-25');
  });

  it('sastLocalToUtc converts a SAST local wall-clock to UTC (permanent -02:00)', () => {
    const iso = sastLocalToUtc('2026-06-25', '10:00').toISOString();
    expect(iso).toBe('2026-06-25T08:00:00.000Z');
  });

  it('sastDayWindows returns todayStart / todayEnd / upcomingEnd bracketing the SAST day', () => {
    const now = new Date('2026-06-25T14:00:00Z');   // 16:00 SAST
    const w   = sastDayWindows(now);
    expect(w.todayStartUtc.toISOString()).toBe('2026-06-24T22:00:00.000Z');   // 00:00 SAST 25 Jun
    expect(w.todayEndUtc.toISOString()).toBe('2026-06-25T22:00:00.000Z');      // 00:00 SAST 26 Jun
    expect(w.upcomingEndUtc.toISOString()).toBe('2026-07-02T22:00:00.000Z');   // +7 days
  });

  it('sastDayWindows crosses month boundaries cleanly', () => {
    // 2026-06-30 20:00 UTC → 2026-06-30 22:00 SAST — still 30 Jun in SAST
    const now = new Date('2026-06-30T20:00:00Z');
    const w   = sastDayWindows(now);
    expect(w.todayStartUtc.toISOString()).toBe('2026-06-29T22:00:00.000Z');
    expect(w.todayEndUtc.toISOString()).toBe('2026-06-30T22:00:00.000Z');
    expect(w.upcomingEndUtc.toISOString()).toBe('2026-07-07T22:00:00.000Z');
  });
});
