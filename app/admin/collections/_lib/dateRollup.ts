// ─── Collections date rollup ────────────────────────────────────────────────
//
// The /admin/collections page is for operational oversight of the
// collection FLOW — "what's hitting each day, what's collected, what's
// failing today" — not for inspecting individual installments (that's
// the customer record / collection detail page's job).
//
// This module groups payment rows by due_date, sums counts + amounts,
// records the bucket mix per date, and emits an ordered list ready for
// rendering. Pure function; tested in isolation in [[dateRollup-test]].
//
// `tone` per date follows a hierarchy:
//   red    — date has at least one 'overdue' bucket row
//            (scheduled with due_date < today; cron hasn't picked it up)
//   amber  — date equals today (the operator's current focus)
//   default
//
// Sort modes:
//   asc  — oldest first; right for chips where the urgency is "I should
//          handle the oldest first" (overdue) OR "what's coming next"
//          (upcoming, all).
//   desc — most recent first; right for historical chips (collected,
//          failed, written_off, processing).
//
// The caller picks the sort mode per chip via `sortModeForChip()`.

import {
  classifyCollection,
  type CollectionBucket,
} from '../../_components/CollectionStatusBadge';

export type DateRollupRow = {
  status:   string;
  due_date: string;
  amount:   number | string;
};

export type DateRollupSortMode = 'asc' | 'desc';

export type DateRollupMix = Partial<Record<CollectionBucket, number>>;

export type DateRollup<T extends DateRollupRow> = {
  date:  string;          // 'YYYY-MM-DD'
  rows:  T[];
  count: number;
  total: number;
  mix:   DateRollupMix;
  tone:  'red' | 'amber' | 'default';
};

function toNum(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

export function rollupByDate<T extends DateRollupRow>(
  rows:     T[],
  today:    string,
  sortMode: DateRollupSortMode,
): DateRollup<T>[] {
  const map = new Map<string, DateRollup<T>>();

  for (const row of rows) {
    let r = map.get(row.due_date);
    if (!r) {
      r = { date: row.due_date, rows: [], count: 0, total: 0, mix: {}, tone: 'default' };
      map.set(row.due_date, r);
    }
    r.rows.push(row);
    r.count++;
    r.total += toNum(row.amount);
    const bucket = classifyCollection(row, today);
    r.mix[bucket] = (r.mix[bucket] ?? 0) + 1;
  }

  // Resolve tone after all rows are bucketed so we see the full mix
  // for the date (a date with 5 collected + 1 overdue is still red).
  for (const r of map.values()) {
    if ((r.mix.overdue ?? 0) > 0) r.tone = 'red';
    else if (r.date === today)    r.tone = 'amber';
    else                          r.tone = 'default';
  }

  const list = [...map.values()];
  list.sort((a, b) =>
    sortMode === 'asc'
      ? a.date.localeCompare(b.date)
      : b.date.localeCompare(a.date),
  );

  return list;
}

// ─── Sort + label helpers ───────────────────────────────────────────────────

export type ChipKey =
  | 'overdue'
  | 'upcoming'
  | 'processing'
  | 'failed'
  | 'collected'
  | 'written_off'
  | 'all';

/**
 * Sort mode per chip:
 *   overdue    — oldest first (most urgent at top)
 *   upcoming   — soonest future first
 *   all        — ascending (overdue at top, future at bottom)
 *   processing — most recent in-flight first
 *   failed     — most recent failure first (most actionable)
 *   collected  — most recent activity first
 *   written_off — most recent loss first
 */
export function sortModeForChip(chip: ChipKey): DateRollupSortMode {
  switch (chip) {
    case 'overdue':
    case 'upcoming':
    case 'all':
      return 'asc';
    case 'processing':
    case 'failed':
    case 'collected':
    case 'written_off':
      return 'desc';
  }
}

// Short labels used in the mix line — matches the chip vocabulary on
// the same page. Kept here (and re-exported from the page) so the
// mix display and the chip bar stay in lock-step.
export const BUCKET_MIX_LABEL: Record<CollectionBucket, string> = {
  overdue:     'overdue',
  upcoming:    'upcoming',
  processing:  'awaiting',
  failed:      'failed',
  collected:   'collected',
  written_off: 'written off',
};
