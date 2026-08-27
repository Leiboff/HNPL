import { describe, it, expect } from 'vitest';
import { bucketFollowups, isMissingNextAction, bucketWakingToday } from './followups';

// Fixed reference "now": 2026-06-25 14:00 UTC = 16:00 SAST.
const NOW = new Date('2026-06-25T14:00:00Z');

function row(id: string, follow_up: string | null, stage = 'contacted') {
  return { id, next_follow_up_at: follow_up, stage };
}

describe('bucketFollowups', () => {
  it('assigns rows to overdue / today / upcoming by SAST calendar day', () => {
    const rows = [
      row('A', '2026-06-24T10:00:00Z'),    // yesterday SAST → overdue
      row('B', '2026-06-25T12:00:00Z'),    // today SAST     → today
      row('C', '2026-06-25T22:30:00Z'),    // 00:30 SAST 26  → tomorrow → upcoming
      row('D', '2026-06-30T10:00:00Z'),    // within 7d      → upcoming
      row('E', '2026-07-05T10:00:00Z'),    // > +7d          → NOT bucketed
      row('F', null),                       // no follow-up   → excluded
    ];
    const b = bucketFollowups(rows, NOW);
    expect(b.overdue.map(r => r.id)).toEqual(['A']);
    expect(b.today.map(r => r.id)).toEqual(['B']);
    expect(b.upcoming.map(r => r.id)).toEqual(['C', 'D']);
  });

  it('drops terminal-stage rows from every bucket', () => {
    const rows = [
      row('X', '2026-06-24T10:00:00Z', 'lost'),
      row('Y', '2026-06-25T12:00:00Z', 'onboarded'),
      row('Z', '2026-06-25T12:00:00Z', 'signed'),
    ];
    const b = bucketFollowups(rows, NOW);
    expect(b.overdue).toHaveLength(0);
    expect(b.today).toHaveLength(0);
    expect(b.upcoming).toHaveLength(0);
  });

  it('handles month-boundary bucketing correctly', () => {
    const monthEnd = new Date('2026-06-30T20:00:00Z');  // 30 Jun 22:00 SAST
    const rows = [
      row('A', '2026-06-30T05:00:00Z'),    // today SAST → today (30 Jun 07:00 SAST)
      row('B', '2026-07-01T05:00:00Z'),    // 07:00 SAST 1 Jul → upcoming
      row('C', '2026-06-29T05:00:00Z'),    // yesterday SAST → overdue
    ];
    const b = bucketFollowups(rows, monthEnd);
    expect(b.today.map(r => r.id)).toEqual(['A']);
    expect(b.overdue.map(r => r.id)).toEqual(['C']);
    expect(b.upcoming.map(r => r.id)).toEqual(['B']);
  });

  it('sorts each bucket chronologically ascending', () => {
    const rows = [
      row('later',    '2026-06-24T18:00:00Z'),
      row('earlier',  '2026-06-24T06:00:00Z'),
    ];
    const b = bucketFollowups(rows, NOW);
    expect(b.overdue.map(r => r.id)).toEqual(['earlier', 'later']);
  });

  it('excludes nurture leads even when next_follow_up_at is a stale overdue date — every nurtured lead must not show as overdue', () => {
    const rows = [row('N', '2026-01-01T00:00:00Z', 'nurture')];
    const b = bucketFollowups(rows, NOW);
    expect(b.overdue).toHaveLength(0);
    expect(b.today).toHaveLength(0);
    expect(b.upcoming).toHaveLength(0);
  });
});

describe('bucketWakingToday', () => {
  function nurtureRow(id: string, wake: string | null, stage = 'nurture') {
    return { id, stage, nurture_wake_at: wake };
  }

  it('a nurtured lead with a future wake date appears in NO bucket', () => {
    const rows = [nurtureRow('future', '2026-07-01T00:00:00Z')];
    expect(bucketWakingToday(rows, NOW)).toHaveLength(0);
  });

  it('a nurtured lead appears once its wake date (today, SAST) has arrived', () => {
    const rows = [nurtureRow('today', '2026-06-25T12:00:00Z')]; // today SAST
    expect(bucketWakingToday(rows, NOW).map(r => r.id)).toEqual(['today']);
  });

  it('keeps showing a nurtured lead whose wake date has already passed (rep has not acted yet)', () => {
    const rows = [nurtureRow('overdue-wake', '2026-06-01T00:00:00Z')];
    expect(bucketWakingToday(rows, NOW).map(r => r.id)).toEqual(['overdue-wake']);
  });

  it('ignores non-nurture stages and rows with no wake date', () => {
    const rows = [
      { id: 'not-nurture', stage: 'contacted', nurture_wake_at: '2026-06-01T00:00:00Z' },
      nurtureRow('no-wake', null),
    ];
    expect(bucketWakingToday(rows, NOW)).toHaveLength(0);
  });
});

describe('isMissingNextAction', () => {
  it('returns true for non-terminal stage with no next_follow_up_at', () => {
    expect(isMissingNextAction({ stage: 'contacted',     next_follow_up_at: null })).toBe(true);
    expect(isMissingNextAction({ stage: 'demo_done',     next_follow_up_at: null })).toBe(true);
    expect(isMissingNextAction({ stage: 'agreement_sent',next_follow_up_at: null })).toBe(true);
  });

  it('returns false for terminal stages', () => {
    expect(isMissingNextAction({ stage: 'signed',    next_follow_up_at: null })).toBe(false);
    expect(isMissingNextAction({ stage: 'onboarded', next_follow_up_at: null })).toBe(false);
    expect(isMissingNextAction({ stage: 'lost',      next_follow_up_at: null })).toBe(false);
  });

  it('returns false when a next action is scheduled', () => {
    expect(isMissingNextAction({ stage: 'contacted', next_follow_up_at: '2026-07-01T00:00:00Z' })).toBe(false);
  });
});
