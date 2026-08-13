import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import BillsBlock, { RECENT_BILLS_LIMIT } from './BillsBlock';
import type { PlanSummary } from './billHelpers';
import type { TradingGateResult } from '@/lib/practice/tradingGate';

// ─── "Recent bills" — the dashboard card, which is now actually recent ─────
//
// The card rendered every row the dashboard had fetched (up to 500) under a
// heading that said "Recent". It now shows RECENT_BILLS_LIMIT rows.
//
// The interesting assertions here are not that it truncates — they are the
// things that must NOT truncate with it:
//
//   • both exports still carry every row. A display that truncates and then
//     exports what it displays loses data in a file that looks complete, so
//     the CSV and the PDF are read back here row by row.
//   • the count line names the set it counts. "40" over eight rows with no
//     explanation is the failure this is guarding against.
//   • the empty states still key off the totals, not off what fits on screen.
//
// The row markup itself is ./BillsTable.test.tsx's job; this file only ever
// counts rows by their toggle testids.

const GATE: TradingGateResult = { ok: true } as TradingGateResult;

function plan(over: Partial<PlanSummary> & { id: string }): PlanSummary {
  return {
    total_amount:       1000,
    status:             'active',
    created_at:         '2026-03-01T10:00:00Z',
    invoice_number:     null,
    practice_reference: null,
    provider_member_id: null,
    patient:            { first_name: 'Nomsa', last_name: 'Dlamini' },
    provider_member:    null,
    payouts:            null,
    invitations:        null,
    ...over,
  };
}

/**
 * N plans, newest first — the order the server already sorted them into
 * (`.order('created_at', { ascending: false })`). Ids are 1-based and padded
 * so `b-01` is the most recent, which makes "the most recent 8" readable as
 * an assertion rather than something to work out.
 */
const series = (n: number): PlanSummary[] =>
  Array.from({ length: n }, (_, i) =>
    plan({
      id:             `b-${String(i + 1).padStart(2, '0')}`,
      invoice_number: `INV-${String(i + 1).padStart(3, '0')}`,
      total_amount:   100 * (i + 1),
      // Descending, one day apart.
      created_at:     new Date(Date.UTC(2026, 2, 28 - i, 10, 0, 0)).toISOString(),
    }),
  );

const TWELVE = series(12);
const FIVE   = series(5);

function renderBlock(
  plans: PlanSummary[],
  over: { totalCount?: number; hasFilters?: boolean; practiceId?: string } = {},
) {
  return render(
    <BillsBlock
      plans={plans}
      totalCount={over.totalCount ?? plans.length}
      hasFilters={over.hasFilters ?? false}
      feePercent={6}
      specialtyMap={{}}
      practiceName="Rosebank Family Practice"
      gate={GATE}
      practiceId={over.practiceId}
    />,
  );
}

const visibleRowIds = () =>
  screen.getAllByTestId(/^bill-toggle:/).map((el) => el.getAttribute('data-testid')!.split(':')[1]);

const openMenu = () => fireEvent.click(screen.getByTitle('Export'));

// ─── The card is recent ───────────────────────────────────────────────────

describe('the list is truncated to the most recent few', () => {
  it('shows exactly RECENT_BILLS_LIMIT rows out of twelve', () => {
    renderBlock(TWELVE);
    expect(visibleRowIds().length).toBe(RECENT_BILLS_LIMIT);
  });

  it('shows the MOST RECENT ones, in the order the server sent them', () => {
    // Not an arbitrary eight: the head of a descending list. A .slice() from
    // the wrong end would still render eight rows and pass a count assertion.
    renderBlock(TWELVE);
    expect(visibleRowIds()).toEqual([
      'b-01', 'b-02', 'b-03', 'b-04', 'b-05', 'b-06', 'b-07', 'b-08',
    ]);
  });

  it('does not truncate a practice that has fewer than the limit', () => {
    renderBlock(FIVE);
    expect(visibleRowIds().length).toBe(5);
    expect(screen.queryByTestId('bills-see-all-footer')).toBeNull();
  });

  it('renders through the shared table, not a second one', () => {
    renderBlock(TWELVE);
    expect(screen.getByTestId('bills-desktop')).toBeTruthy();
    expect(screen.getByTestId('bills-mobile')).toBeTruthy();
  });

  it('truncates the filtered set, not the unfiltered one', () => {
    // 12 matched out of a 500-row fetch: still 8 on screen.
    renderBlock(TWELVE, { hasFilters: true, totalCount: 500 });
    expect(visibleRowIds().length).toBe(RECENT_BILLS_LIMIT);
  });
});

// ─── The count line ───────────────────────────────────────────────────────

describe('the count line says which set it is counting', () => {
  it('states the truncation explicitly when there is more than fits', () => {
    renderBlock(TWELVE);
    expect(screen.getByTestId('bills-card-count').textContent)
      .toBe('Showing the 8 most recent of 12 bills');
  });

  it('compares against the MATCHING count when filters are on', () => {
    // The filter bar above already says "12 of 500"; this line is about the
    // gap between what matched and what is on screen.
    renderBlock(TWELVE, { hasFilters: true, totalCount: 500 });
    expect(screen.getByTestId('bills-card-count').textContent)
      .toBe('Showing the 8 most recent of 12 matching bills');
  });

  it('never claims a number the list does not explain', () => {
    // The specific failure this guards: a bare "12" over eight rows.
    renderBlock(TWELVE);
    const text = screen.getByTestId('bills-card-count').textContent!;
    expect(text).toMatch(/Showing the 8 most recent/);
    expect(text).not.toBe('12 of 12 bills');
  });

  it('keeps the old filtered count untouched when nothing is truncated', () => {
    renderBlock(FIVE, { hasFilters: true, totalCount: 40 });
    expect(screen.getByTestId('bills-card-count').textContent).toBe('5 of 40 bills');
  });

  it('shows no count line at all when unfiltered and untruncated', () => {
    // Nothing to explain — what you see is everything there is.
    renderBlock(FIVE);
    expect(screen.queryByTestId('bills-card-count')).toBeNull();
  });

  it('agrees with the number of rows it claims to be showing', () => {
    renderBlock(TWELVE);
    const claimed = Number(
      screen.getByTestId('bills-card-count').textContent!.match(/the (\d+) most recent/)![1],
    );
    expect(claimed).toBe(visibleRowIds().length);
  });
});

// ─── The escape hatch ─────────────────────────────────────────────────────

describe('See all reaches the full list', () => {
  it('the header link points at the Bills tab', () => {
    renderBlock(TWELVE);
    expect(screen.getByTestId('bills-see-all').getAttribute('href')).toBe('/practice/bills');
  });

  it('adds a second link below the rows, where the list runs out', () => {
    renderBlock(TWELVE);
    const footer = screen.getByTestId('bills-see-all-footer');
    expect(footer.getAttribute('href')).toBe('/practice/bills');
    expect(footer.textContent).toBe('See all 12 bills →');
  });

  it('both links carry the practice scope, so a brand-admin stays on the branch', () => {
    renderBlock(TWELVE, { practiceId: 'prac-7' });
    for (const id of ['bills-see-all', 'bills-see-all-footer']) {
      expect(screen.getByTestId(id).getAttribute('href'), id)
        .toBe('/practice/bills?practiceId=prac-7');
    }
  });
});

// ─── Export must not shrink with the display ───────────────────────────────

describe('the exports still carry every row', () => {
  let objectUrl: ReturnType<typeof vi.spyOn>;
  let blobs: Blob[];

  beforeEach(() => {
    blobs = [];
    objectUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
      blobs.push(b as Blob);
      return 'blob:test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    objectUrl.mockRestore?.();
  });

  async function exportedCsv(plans: PlanSummary[], over = {}) {
    renderBlock(plans, over);
    openMenu();
    fireEvent.click(screen.getByText('Export CSV'));
    expect(blobs.length).toBe(1);
    return await blobs[0].text();
  }

  it('the CSV holds all twelve rows while the list shows eight', async () => {
    const csv = await exportedCsv(TWELVE);
    // One header row plus one row per bill.
    expect(csv.trim().split('\n').length).toBe(TWELVE.length + 1);
  });

  it('the CSV names every invoice, including the four not on screen', async () => {
    const csv = await exportedCsv(TWELVE);
    for (const p of TWELVE) expect(csv, p.invoice_number!).toContain(p.invoice_number!);
    // The proof that this is not vacuous: those last four are genuinely absent
    // from the rendered list.
    expect(visibleRowIds()).not.toContain('b-12');
  });

  it('the PDF holds all twelve rows too', () => {
    const written: string[] = [];
    const fakeWin = {
      document: { write: (h: string) => written.push(h), close: () => {} },
      focus: () => {}, print: () => {},
    };
    vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window);

    renderBlock(TWELVE);
    openMenu();
    fireEvent.click(screen.getByText('Export PDF'));

    expect(written.length).toBe(1);
    // Body rows only — the <thead> has a <tr> of its own.
    expect(written[0].match(/<tr>\s*<td>/g)!.length).toBe(TWELVE.length);
    for (const p of TWELVE) expect(written[0], p.invoice_number!).toContain(p.invoice_number!);
  });

  it('still exports the FILTERED set, not the whole ledger', async () => {
    // Truncation must not turn "export what matched" into "export everything"
    // either — the parent hands down the matching rows and those are the rows.
    const csv = await exportedCsv(TWELVE, { hasFilters: true, totalCount: 500 });
    expect(csv.trim().split('\n').length).toBe(TWELVE.length + 1);
  });

  it('says in the menu how many rows the file will hold', () => {
    renderBlock(TWELVE);
    openMenu();
    expect(screen.getByTestId('bills-export-scope').textContent)
      .toBe('Exports all 12 bills, not just the 8 shown.');
  });

  it('says so about the matching set when filters are on', () => {
    renderBlock(TWELVE, { hasFilters: true, totalCount: 500 });
    openMenu();
    expect(screen.getByTestId('bills-export-scope').textContent)
      .toBe('Exports all 12 matching bills, not just the 8 shown.');
  });

  it('stays quiet when the list is not truncated — nothing to warn about', () => {
    renderBlock(FIVE);
    openMenu();
    expect(screen.queryByTestId('bills-export-scope')).toBeNull();
  });
});

// ─── Untouched by the truncation ──────────────────────────────────────────

describe('the rest of the card is unchanged', () => {
  it('shows the empty state from the unfiltered total, not from row count', () => {
    renderBlock([], { totalCount: 0 });
    expect(screen.getByText('No bills yet')).toBeTruthy();
    expect(screen.queryByTestId('bills-desktop')).toBeNull();
    // No export menu, no See all, when there is nothing at all.
    expect(screen.queryByTestId('bills-see-all')).toBeNull();
  });

  it('distinguishes "no matches" from "no bills"', () => {
    renderBlock([], { totalCount: 40, hasFilters: true });
    expect(screen.getByText('No bills match your filters')).toBeTruthy();
    expect(screen.queryByText('No bills yet')).toBeNull();
    // The header still offers the way out to the full list.
    expect(screen.getByTestId('bills-see-all')).toBeTruthy();
  });

  it('keeps its heading', () => {
    renderBlock(TWELVE);
    expect(screen.getByText('Recent bills')).toBeTruthy();
  });
});

// ─── Where the truncation is allowed to live ──────────────────────────────

describe('truncation stays in one place', () => {
  const read = (p: string) =>
    stripComments(readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n'));

  const BLOCK   = read('app/practice/BillsBlock.tsx');
  const CLIENT  = read('app/practice/PracticeDashboardClient.tsx');
  const PAYOUTS = read('app/practice/payouts/page.tsx');

  it('the parent hands down the FULL filtered set', () => {
    // Slicing here instead would shrink the exports and the counts with the
    // display, and neither would say so.
    expect(CLIENT).toMatch(/<BillsBlock\s+plans=\{filteredPlans\}/);
    expect(CLIENT).not.toMatch(/filteredPlans\.slice/);
  });

  // This used to read: "the chart still gets every matching row", asserting
  // <MonthlyRevenueChart plans={filteredPlans}> on the dashboard. The chart has
  // since MOVED to /practice/payouts, so that assertion could no longer be
  // true — the subject was deliberately removed, not the invariant. The
  // invariant was "a truncated display must not truncate what the chart
  // aggregates", and it is re-asserted below at the chart's new home. Neither
  // half is weaker: the dashboard side is now an absence check (a chart back
  // here would be a second mount), and the payouts side forbids a slice on the
  // rows it is fed.

  it('the chart is no longer on the dashboard at all', () => {
    expect(CLIENT).not.toMatch(/MonthlyRevenueChart/);
  });

  it('the chart gets every fetched row at its new home, unsliced', () => {
    // A year-scale revenue trend drawn from a truncated array would understate
    // months — the same failure the dashboard version was guarded against,
    // one screen across.
    expect(PAYOUTS).toMatch(/<MonthlyRevenueChart plans=\{chartPlans \?\? \[\]\}/);
    expect(PAYOUTS).not.toMatch(/chartPlans\??\.?\s*\.slice/);
  });

  it('the card slices the plans array exactly once', () => {
    // (The other .slice in this file is the export filename's date.)
    expect(BLOCK.match(/plans\.slice\(/g)!.length).toBe(1);
    expect(BLOCK).toMatch(/const visible\s+= truncated \? plans\.slice\(0, RECENT_BILLS_LIMIT\) : plans/);
    expect(BLOCK).toMatch(/<BillsTable plans=\{visible\}/);
  });

  it('neither export reads the truncated array', () => {
    // `visible` may appear only at the BillsTable call site. Anchor the end on
    // the component's OWN return, not the first one — the icon helpers above
    // have returns of their own.
    const start     = BLOCK.indexOf('function handleExportCSV');
    const exportFns = BLOCK.slice(start, BLOCK.indexOf('return (', start));
    expect(exportFns.length).toBeGreaterThan(500);
    expect(exportFns).not.toMatch(/visible/);
    expect(exportFns).toMatch(/plans\.map\(/);
  });
});
