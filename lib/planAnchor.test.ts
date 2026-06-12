import { describe, it, expect } from 'vitest';
import { planCompletionDate, planAnchorDate, sortPlansByAnchorDesc } from './planAnchor';

const ISO = (s: string) => s;       // readability sugar in tests

describe('planCompletionDate', () => {
  it('returns the latest collected_at across collected payments', () => {
    expect(planCompletionDate({
      created_at: ISO('2026-06-01T00:00:00Z'),
      payments: [
        { status: 'collected', collected_at: '2026-07-04T08:00:00Z' },
        { status: 'collected', collected_at: '2026-08-04T08:00:00Z' },
        { status: 'collected', collected_at: '2026-09-04T08:00:00Z' },
      ],
    })).toBe('2026-09-04T08:00:00Z');
  });

  it('ignores non-collected payments even if they have a collected_at value', () => {
    expect(planCompletionDate({
      created_at: ISO('2026-06-01T00:00:00Z'),
      payments: [
        { status: 'collected',  collected_at: '2026-07-04T08:00:00Z' },
        { status: 'scheduled',  collected_at: '2026-08-04T08:00:00Z' }, // stale, must be ignored
      ],
    })).toBe('2026-07-04T08:00:00Z');
  });

  it('returns null when no payments are collected', () => {
    expect(planCompletionDate({
      created_at: ISO('2026-06-01T00:00:00Z'),
      payments: [
        { status: 'scheduled', collected_at: null },
        { status: 'scheduled', collected_at: null },
      ],
    })).toBeNull();
  });

  it('returns null when payments[] is empty', () => {
    expect(planCompletionDate({
      created_at: ISO('2026-06-01T00:00:00Z'),
      payments: [],
    })).toBeNull();
  });

  it('handles missing collected_at on a collected row defensively (skips it)', () => {
    expect(planCompletionDate({
      created_at: ISO('2026-06-01T00:00:00Z'),
      payments: [
        { status: 'collected', collected_at: null },
        { status: 'collected', collected_at: '2026-07-04T08:00:00Z' },
      ],
    })).toBe('2026-07-04T08:00:00Z');
  });
});

describe('planAnchorDate', () => {
  const plan = {
    created_at: '2026-06-01T00:00:00Z',
    payments: [
      { status: 'collected', collected_at: '2026-09-04T08:00:00Z' },
    ],
  };

  it('Pending tab → created_at (Started …)', () => {
    expect(planAnchorDate(plan, 'pending')).toBe('2026-06-01T00:00:00Z');
  });

  it('Current tab → created_at (Started …)', () => {
    expect(planAnchorDate(plan, 'current')).toBe('2026-06-01T00:00:00Z');
  });

  it('Historic tab → latest collected_at (Completed …)', () => {
    expect(planAnchorDate(plan, 'historic')).toBe('2026-09-04T08:00:00Z');
  });

  it('Historic tab falls back to created_at when no payments are collected', () => {
    const cancelled = {
      created_at: '2026-06-01T00:00:00Z',
      payments: [{ status: 'scheduled', collected_at: null }],
    };
    expect(planAnchorDate(cancelled, 'historic')).toBe('2026-06-01T00:00:00Z');
  });
});

describe('sortPlansByAnchorDesc', () => {
  it('sorts newest-first by created_at on the Current tab', () => {
    const a = { id: 'a', created_at: '2026-06-01T00:00:00Z', payments: [] };
    const b = { id: 'b', created_at: '2026-07-01T00:00:00Z', payments: [] };
    const c = { id: 'c', created_at: '2026-05-01T00:00:00Z', payments: [] };
    const sorted = sortPlansByAnchorDesc([a, b, c], 'current');
    expect(sorted.map((p) => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('Historic tab sorts by completion date when present, mixed with creation-date fallback', () => {
    const completedJun = {
      id: 'completed-jun',
      created_at: '2026-01-01T00:00:00Z',
      payments: [{ status: 'collected' as const, collected_at: '2026-06-15T00:00:00Z' }],
    };
    const cancelledMay = {
      id: 'cancelled-may',
      created_at: '2026-05-10T00:00:00Z',
      payments: [{ status: 'scheduled' as const, collected_at: null }],
    };
    const completedJul = {
      id: 'completed-jul',
      created_at: '2026-02-01T00:00:00Z',
      payments: [{ status: 'collected' as const, collected_at: '2026-07-20T00:00:00Z' }],
    };
    const sorted = sortPlansByAnchorDesc(
      [completedJun, cancelledMay, completedJul],
      'historic',
    );
    // completed-jul (Jul 20) > completed-jun (Jun 15) > cancelled-may (created May 10)
    expect(sorted.map((p) => p.id)).toEqual(['completed-jul', 'completed-jun', 'cancelled-may']);
  });

  it('is stable for identical anchor strings (preserves original relative order)', () => {
    const a = { id: 'a', created_at: '2026-06-01T00:00:00Z', payments: [] };
    const b = { id: 'b', created_at: '2026-06-01T00:00:00Z', payments: [] };
    const c = { id: 'c', created_at: '2026-06-01T00:00:00Z', payments: [] };
    const sorted = sortPlansByAnchorDesc([a, b, c], 'current');
    expect(sorted.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const arr = [
      { created_at: '2026-06-01T00:00:00Z', payments: [] },
      { created_at: '2026-07-01T00:00:00Z', payments: [] },
    ];
    const snapshot = arr.map((p) => p.created_at);
    sortPlansByAnchorDesc(arr, 'current');
    expect(arr.map((p) => p.created_at)).toEqual(snapshot);
  });
});
