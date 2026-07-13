import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import MergedPlansCard, { type MergedPlanRow, type MergedHeadline } from './MergedPlansCard';

// ─── MergedPlansCard — behavioural fixture tests ─────────────────────
//
// The merged card replaces both InstalmentHero and YourPlansCard.
// These tests port InstalmentHero.test.tsx's ladder-state coverage AND
// add cap/empty/sum coverage that was missing before (the two-card
// version had this data split, so no test could verify the sum
// property or the "each practice appears once" invariant).

function baseRow(overrides: Partial<MergedPlanRow> = {}): MergedPlanRow {
  return {
    id:            'plan-1',
    practiceName:  'Norwood Medical',
    paid:          1,
    total:         3,
    percent:       33,
    isPaidInFull:  false,
    nextAmount:    150,
    nextDate:      '2026-08-01',
    ...overrides,
  };
}

function baseHeadline(overrides: Partial<MergedHeadline> = {}): MergedHeadline {
  return {
    dueDate:      '2026-08-01',
    total:        150,
    isOverdue:    false,
    isToday:      false,
    groupState:   'scheduled',
    instalments:  [],
    ...overrides,
  };
}

// ── 0 plans → empty state ─────────────────────────────────────────────

describe('MergedPlansCard — 0 active plans', () => {
  it('renders the compact empty state + Find-care link, hides the headline zone', () => {
    render(<MergedPlansCard headline={null} activeCount={0} totalCount={0} rows={[]} />);
    expect(screen.getByTestId('merged-plans-empty')).toBeDefined();
    expect(screen.getByTestId('merged-plans-find-care')).toBeDefined();
    // No headline zone in the empty variant
    expect(screen.queryByTestId('merged-plans-headline')).toBeNull();
    expect(screen.queryByTestId('merged-plans-rows')).toBeNull();
  });

  it('shows a "See N past plans" link when the patient has historic-only plans', () => {
    render(<MergedPlansCard headline={null} activeCount={0} totalCount={2} rows={[]} />);
    expect(screen.getByTestId('merged-plans-past-link').textContent).toMatch(/See 2 past plans/);
  });
});

// ── 1 plan — single row, sum property holds trivially ─────────────────

describe('MergedPlansCard — 1 active plan', () => {
  it('renders exactly one row and the headline amount equals that row\'s next amount', () => {
    const row = baseRow({ practiceName: 'Solo Optom', nextAmount: 350 });
    render(<MergedPlansCard headline={baseHeadline({ total: 350 })} activeCount={1} totalCount={1} rows={[row]} />);
    const rows = screen.getAllByTestId('merged-plans-row');
    expect(rows.length).toBe(1);
    expect(within(rows[0]).getByTestId('merged-plans-row-name').textContent).toBe('Solo Optom');
    expect(screen.getByTestId('merged-plans-headline-amount').textContent).toContain('R350');
  });

  it('does NOT show View-all when there is only one plan', () => {
    render(<MergedPlansCard headline={baseHeadline()} activeCount={1} totalCount={1} rows={[baseRow()]} />);
    expect(screen.queryByTestId('merged-plans-view-all')).toBeNull();
  });
});

// ── 2 plans — sum property + no duplicates ────────────────────────────

describe('MergedPlansCard — 2 active plans (same next date)', () => {
  const rows: MergedPlanRow[] = [
    baseRow({ id: 'p1', practiceName: 'Norwood Medical', nextAmount: 150, paid: 1, total: 3, percent: 33 }),
    baseRow({ id: 'p2', practiceName: 'Cape Physio',    nextAmount: 350, paid: 0, total: 2, percent: 0 }),
  ];

  it('renders each practice name exactly once', () => {
    render(<MergedPlansCard headline={baseHeadline({ total: 500 })} activeCount={2} totalCount={2} rows={rows} />);
    const names = screen.getAllByTestId('merged-plans-row-name').map(n => n.textContent);
    expect(names).toEqual(['Norwood Medical', 'Cape Physio']);
    expect(new Set(names).size).toBe(names.length);   // no dupes
  });

  it('per-plan next amounts sum to the headline total', () => {
    render(<MergedPlansCard headline={baseHeadline({ total: 500 })} activeCount={2} totalCount={2} rows={rows} />);
    const rowAmounts = screen.getAllByTestId('merged-plans-row-amount').map(el => {
      const m = el.textContent?.match(/R([\d,]+(?:\.\d+)?)/);
      return m ? Number(m[1].replace(/,/g, '')) : 0;
    });
    const sum = rowAmounts.reduce((a, b) => a + b, 0);
    const headline = screen.getByTestId('merged-plans-headline-amount').textContent!;
    const headlineNum = Number(headline.replace(/[R,]/g, ''));
    expect(sum).toBe(500);
    expect(headlineNum).toBe(sum);
  });
});

// ── 4 plans — cap at 3 + View all ────────────────────────────────────

describe('MergedPlansCard — 4 active plans (cap-at-3)', () => {
  const rows: MergedPlanRow[] = [
    baseRow({ id: 'p1', practiceName: 'A' }),
    baseRow({ id: 'p2', practiceName: 'B' }),
    baseRow({ id: 'p3', practiceName: 'C' }),
    baseRow({ id: 'p4', practiceName: 'D' }),
  ];

  it('renders only the first 3 rows and a View-all link', () => {
    render(<MergedPlansCard headline={baseHeadline()} activeCount={4} totalCount={4} rows={rows} />);
    const names = screen.getAllByTestId('merged-plans-row-name').map(n => n.textContent);
    expect(names).toEqual(['A', 'B', 'C']);
    const viewAll = screen.getByTestId('merged-plans-view-all');
    expect(viewAll.textContent).toMatch(/View all 4/);
  });
});

// ── Ladder-state display (ported from InstalmentHero.test.tsx) ────────

describe('MergedPlansCard — headline ladder-state display', () => {
  it('scheduled shows "Next Instalment" + "Due {date}"', () => {
    render(
      <MergedPlansCard
        headline={baseHeadline({ dueDate: '2026-08-01', total: 500 })}
        activeCount={1} totalCount={1} rows={[baseRow()]}
      />
    );
    const headline = screen.getByTestId('merged-plans-headline');
    expect(headline.textContent).toMatch(/Next Instalment/i);
    expect(headline.textContent).toMatch(/Due 1 Aug 2026/);
  });

  it('failed shows "Payment Failed" + retry copy', () => {
    render(
      <MergedPlansCard
        headline={baseHeadline({ groupState: 'failed', dueDate: '2026-08-01' })}
        activeCount={1} totalCount={1} rows={[baseRow()]}
      />
    );
    const headline = screen.getByTestId('merged-plans-headline');
    expect(headline.textContent).toMatch(/Payment Failed/i);
    expect(headline.textContent).toMatch(/We'll retry on 1 Aug 2026/i);
  });

  it('defaulted shows "In Default — Please Settle"', () => {
    render(
      <MergedPlansCard
        headline={baseHeadline({ groupState: 'defaulted' })}
        activeCount={1} totalCount={1} rows={[baseRow()]}
      />
    );
    const headline = screen.getByTestId('merged-plans-headline');
    expect(headline.textContent).toMatch(/In Default/i);
    expect(headline.textContent).toMatch(/No further retries/i);
  });

  it('overdue shows "Amount Overdue" + "was due …"', () => {
    render(
      <MergedPlansCard
        headline={baseHeadline({ isOverdue: true, dueDate: '2026-07-01' })}
        activeCount={1} totalCount={1} rows={[baseRow()]}
      />
    );
    const headline = screen.getByTestId('merged-plans-headline');
    expect(headline.textContent).toMatch(/Amount Overdue/i);
    expect(headline.textContent).toMatch(/was due 1 Jul 2026/);
  });
});

// ── Active-plans-but-no-headline (edge case) ─────────────────────────

describe('MergedPlansCard — active plans without a headline', () => {
  it('renders the rows and a "Your Plans — X active" label instead of the headline', () => {
    render(
      <MergedPlansCard
        headline={null}
        activeCount={1}
        totalCount={1}
        rows={[baseRow({ isPaidInFull: true, nextAmount: null, nextDate: null })]}
      />
    );
    // No headline zone, but the card still renders — rows are visible.
    expect(screen.queryByTestId('merged-plans-headline')).toBeNull();
    expect(screen.getByTestId('merged-plans-rows')).toBeDefined();
    // Paid-in-full row shows "Paid in full" instead of "X of Y paid".
    expect(screen.getByTestId('merged-plans-row-paid').textContent).toMatch(/Paid in full/);
  });
});
