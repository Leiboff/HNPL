import { describe, it, expect } from 'vitest';
import { computeAccountRows } from './accounts';

const NOW = new Date('2026-08-26T12:00:00Z');
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

describe('9. Accounts view shows correct trailing-30-day billings against seeded payments', () => {
  it('sums only collected payments within the trailing 30 days', () => {
    const rows = computeAccountRows(
      [{ id: 'lead1', practice_name: 'Acme', estimated_monthly_billings: 10000, converted_practice_id: 'p1' }],
      [{ id: 'p1', name: 'Acme Dental', status: 'approved', approved_at: iso(60) }],
      [{ id: 'plan1', practice_id: 'p1' }],
      [
        { plan_id: 'plan1', amount: 3000, status: 'collected', collected_at: iso(5) },
        { plan_id: 'plan1', amount: 2000, status: 'collected', collected_at: iso(20) },
        { plan_id: 'plan1', amount: 5000, status: 'collected', collected_at: iso(45) }, // outside window
        { plan_id: 'plan1', amount: 1000, status: 'processing', collected_at: null },  // not collected — excluded
      ],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actual30d).toBe(5000);
    expect(rows[0].estimate).toBe(10000);
  });

  it('correctly flags a practice with no bill in 31 days', () => {
    const rows = computeAccountRows(
      [{ id: 'lead1', practice_name: 'Stale Practice', estimated_monthly_billings: 8000, converted_practice_id: 'p1' }],
      [{ id: 'p1', name: 'Stale Practice', status: 'approved', approved_at: iso(90) }],
      [{ id: 'plan1', practice_id: 'p1' }],
      [{ plan_id: 'plan1', amount: 4000, status: 'collected', collected_at: iso(31) }],
      NOW,
    );
    expect(rows[0].needsAttention).toBe(true);
    expect(rows[0].daysSinceLastBill).toBe(31);
    expect(rows[0].actual30d).toBe(0);
  });

  it('a practice billed within 30 days is not flagged', () => {
    const rows = computeAccountRows(
      [{ id: 'lead1', practice_name: 'Healthy Practice', estimated_monthly_billings: 8000, converted_practice_id: 'p1' }],
      [{ id: 'p1', name: 'Healthy Practice', status: 'approved', approved_at: iso(90) }],
      [{ id: 'plan1', practice_id: 'p1' }],
      [{ plan_id: 'plan1', amount: 4000, status: 'collected', collected_at: iso(10) }],
      NOW,
    );
    expect(rows[0].needsAttention).toBe(false);
  });

  it('a converted practice with no payments at all is flagged (never billed)', () => {
    const rows = computeAccountRows(
      [{ id: 'lead1', practice_name: 'Never Billed', estimated_monthly_billings: 5000, converted_practice_id: 'p1' }],
      [{ id: 'p1', name: 'Never Billed', status: 'approved', approved_at: iso(90) }],
      [],
      [],
      NOW,
    );
    expect(rows[0].needsAttention).toBe(true);
    expect(rows[0].daysSinceLastBill).toBeNull();
    expect(rows[0].actual30d).toBe(0);
  });

  it('a lead whose converted_practice_id points at a since-deleted practice is silently excluded, not thrown', () => {
    const rows = computeAccountRows(
      [{ id: 'lead1', practice_name: 'Orphan', estimated_monthly_billings: 5000, converted_practice_id: 'missing-practice' }],
      [],
      [],
      [],
      NOW,
    );
    expect(rows).toHaveLength(0);
  });
});
