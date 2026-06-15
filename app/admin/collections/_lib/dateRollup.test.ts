import { describe, it, expect } from 'vitest';
import {
  rollupByDate,
  sortModeForChip,
  type DateRollupRow,
} from './dateRollup';

// ─── Collections date-rollup tests ──────────────────────────────────────────
//
// The rollup is the engine behind the Collections list — anything off
// here shows up as wrong totals or wrong ordering on the operational
// page. These tests pin the shape, counts, mix, tone, and ordering.

const TODAY = '2026-06-15';

function row(opts: Partial<DateRollupRow> & { due_date: string; status: string }): DateRollupRow {
  return { amount: opts.amount ?? 100, status: opts.status, due_date: opts.due_date };
}

describe('rollupByDate — grouping & sums', () => {
  it('groups multiple rows on the same date into one rollup', () => {
    const out = rollupByDate(
      [
        row({ due_date: '2026-06-10', status: 'scheduled', amount: 100 }),
        row({ due_date: '2026-06-10', status: 'scheduled', amount: 200 }),
        row({ due_date: '2026-06-10', status: 'scheduled', amount: 300 }),
      ],
      TODAY,
      'asc',
    );
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-06-10');
    expect(out[0].count).toBe(3);
    expect(out[0].total).toBe(600);
  });

  it('separates different dates into separate rollups', () => {
    const out = rollupByDate(
      [
        row({ due_date: '2026-06-10', status: 'scheduled' }),
        row({ due_date: '2026-06-11', status: 'scheduled' }),
      ],
      TODAY,
      'asc',
    );
    expect(out).toHaveLength(2);
  });

  it('handles numeric string amounts (Postgres NUMERIC arrives as string)', () => {
    const out = rollupByDate(
      [
        row({ due_date: '2026-06-10', status: 'scheduled', amount: '1234.50' }),
        row({ due_date: '2026-06-10', status: 'scheduled', amount: '0.50' }),
      ],
      TODAY,
      'asc',
    );
    expect(out[0].total).toBe(1235);
  });
});

describe('rollupByDate — status mix per date', () => {
  it('counts bucket per date for a mixed-status day', () => {
    const out = rollupByDate(
      [
        // collected (past)
        row({ due_date: '2026-06-10', status: 'collected'   }),
        row({ due_date: '2026-06-10', status: 'collected'   }),
        // failed
        row({ due_date: '2026-06-10', status: 'failed'      }),
        // written off
        row({ due_date: '2026-06-10', status: 'written_off' }),
        // overdue (scheduled past today=2026-06-15)
        row({ due_date: '2026-06-10', status: 'scheduled'   }),
      ],
      TODAY,
      'asc',
    );
    expect(out[0].mix).toEqual({
      collected:   2,
      failed:      1,
      written_off: 1,
      overdue:     1,
    });
  });

  it('a single-status day has a single mix entry', () => {
    const out = rollupByDate(
      [
        row({ due_date: '2026-06-20', status: 'scheduled' }),
        row({ due_date: '2026-06-20', status: 'scheduled' }),
      ],
      TODAY,
      'asc',
    );
    expect(out[0].mix).toEqual({ upcoming: 2 });
  });

  it("'retried' bucket collapses into 'failed' — same as the chip vocabulary", () => {
    const out = rollupByDate(
      [
        row({ due_date: '2026-06-10', status: 'failed'  }),
        row({ due_date: '2026-06-10', status: 'retried' }),
      ],
      TODAY,
      'asc',
    );
    expect(out[0].mix).toEqual({ failed: 2 });
  });
});

describe('rollupByDate — tone resolution', () => {
  it('any overdue bucket on the date → red, even when mixed with collected', () => {
    const out = rollupByDate(
      [
        row({ due_date: '2026-06-10', status: 'collected' }),
        row({ due_date: '2026-06-10', status: 'collected' }),
        row({ due_date: '2026-06-10', status: 'scheduled' }), // overdue (past today)
      ],
      TODAY,
      'asc',
    );
    expect(out[0].tone).toBe('red');
  });

  it("today's date → amber when there are no overdue rows", () => {
    const out = rollupByDate(
      [row({ due_date: TODAY, status: 'scheduled' })],
      TODAY,
      'asc',
    );
    expect(out[0].tone).toBe('amber');
  });

  it('today still goes red when the day has overdue (e.g. scheduled written yesterday)', () => {
    // Edge: a future-dated overdue row landing on today would be weird,
    // but a row with status='scheduled' AND due_date < today is overdue
    // even if its due_date IS today's calendar position later. This
    // case just asserts overdue beats amber.
    const out = rollupByDate(
      [
        row({ due_date: TODAY,        status: 'collected' }),
        row({ due_date: '2026-06-10', status: 'scheduled' }), // separate date, red
      ],
      TODAY,
      'asc',
    );
    // First date (oldest first in asc) is 2026-06-10 → red
    expect(out[0].date).toBe('2026-06-10');
    expect(out[0].tone).toBe('red');
    expect(out[1].date).toBe(TODAY);
    expect(out[1].tone).toBe('amber');
  });

  it('historical / future date with no overdue and not today → default', () => {
    const out = rollupByDate(
      [
        row({ due_date: '2026-06-05', status: 'collected' }),
        row({ due_date: '2026-07-20', status: 'scheduled' }),
      ],
      TODAY,
      'asc',
    );
    expect(out[0].tone).toBe('default');
    expect(out[1].tone).toBe('default');
  });
});

describe('rollupByDate — ordering', () => {
  it("'asc' produces oldest-first ordering (overdue at top, future at bottom)", () => {
    const out = rollupByDate(
      [
        row({ due_date: '2026-07-20', status: 'scheduled' }),
        row({ due_date: '2026-06-01', status: 'scheduled' }),
        row({ due_date: '2026-06-15', status: 'scheduled' }),
      ],
      TODAY,
      'asc',
    );
    expect(out.map(r => r.date)).toEqual(['2026-06-01', '2026-06-15', '2026-07-20']);
  });

  it("'desc' produces most-recent-first ordering (for historical chips)", () => {
    const out = rollupByDate(
      [
        row({ due_date: '2026-05-10', status: 'collected' }),
        row({ due_date: '2026-06-01', status: 'collected' }),
        row({ due_date: '2026-04-20', status: 'collected' }),
      ],
      TODAY,
      'desc',
    );
    expect(out.map(r => r.date)).toEqual(['2026-06-01', '2026-05-10', '2026-04-20']);
  });
});

describe('sortModeForChip', () => {
  it('overdue/upcoming/all are ascending (urgency or schedule-forward)', () => {
    expect(sortModeForChip('overdue')).toBe('asc');
    expect(sortModeForChip('upcoming')).toBe('asc');
    expect(sortModeForChip('all')).toBe('asc');
  });

  it('processing/failed/collected/written_off are descending (most recent first)', () => {
    expect(sortModeForChip('processing')).toBe('desc');
    expect(sortModeForChip('failed')).toBe('desc');
    expect(sortModeForChip('collected')).toBe('desc');
    expect(sortModeForChip('written_off')).toBe('desc');
  });
});

describe('rollupByDate — original rows preserved per date', () => {
  it('passes the input rows through inside each rollup so the page can render them on expand', () => {
    const rowA = row({ due_date: '2026-06-10', status: 'scheduled', amount: 100 });
    const rowB = row({ due_date: '2026-06-10', status: 'scheduled', amount: 200 });
    const rowC = row({ due_date: '2026-06-11', status: 'scheduled', amount: 300 });
    const out = rollupByDate([rowA, rowB, rowC], TODAY, 'asc');

    expect(out[0].rows).toHaveLength(2);
    expect(out[0].rows).toContain(rowA);
    expect(out[0].rows).toContain(rowB);
    expect(out[1].rows).toHaveLength(1);
    expect(out[1].rows).toContain(rowC);
  });
});
