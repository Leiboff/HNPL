import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { formatRand, formatDateStr, formatDateTime, fullName, practiceName } from '../_lib/format';
import CollectionStatusBadge, { classifyCollection, type CollectionBucket } from '../_components/CollectionStatusBadge';
import {
  rollupByDate,
  sortModeForChip,
  BUCKET_MIX_LABEL,
  type DateRollup,
  type ChipKey,
} from './_lib/dateRollup';
import { parseRangeParams, formatPeriodLabel } from './_lib/dateRange';
import CollectionsDateRangePicker from './CollectionsDateRangePicker';
import { STUCK_PROCESSING_HOURS } from '@/lib/payments/sweepStuckProcessing';

// ─── /admin/collections ─────────────────────────────────────────────────────
//
// Operational oversight of the collection flow — "what's hitting each
// day, what's collected, what's failing today". One rollup row per
// due_date, click to expand. Per-installment detail lives on the
// /admin/collections/[paymentId] page (deep-detail target) and on the
// customer record. This page is the day-by-day summary layer on top
// of the same payments data.
//
// status → bucket mapping (from CollectionStatusBadge):
//   payments.status='processing'                          → awaiting
//   payments.status='scheduled' AND due_date <  today     → overdue
//   payments.status='scheduled' AND due_date >= today     → upcoming
//   payments.status='failed' (or 'retried')               → failed
//   payments.status='collected'                           → collected
//   payments.status='written_off'                         → written_off

type SearchParams = { chip?: string; from?: string; to?: string };

const CHIP_DEFINITIONS: Array<{
  key:         ChipKey;
  label:       string;
  description: string;
}> = [
  { key: 'overdue',     label: 'Overdue',           description: 'Scheduled, past due_date — cron should have picked these up' },
  { key: 'processing',  label: 'Awaiting',          description: 'Charge fired, webhook not yet reconciled' },
  { key: 'upcoming',    label: 'Upcoming',          description: 'Scheduled, due in the future' },
  { key: 'failed',      label: 'Failed / retrying', description: 'Failed, still in the dunning ladder' },
  { key: 'defaulted',   label: 'Defaulted',         description: 'Dunning terminal — debt owed, patient frozen from new plans' },
  { key: 'collected',   label: 'Collected',         description: 'Successfully collected' },
  { key: 'written_off', label: 'Written off',       description: 'Explicit write-off' },
  { key: 'all',         label: 'All',               description: 'Every row' },
];

type PaymentRow = {
  id:                string;
  plan_id:           string;
  patient_id:        string | null;
  instalment_number: number;
  amount:            number;
  due_date:          string;
  status:            string;
  retry_count:       number;
  collected_at:      string | null;
  dunning_fees_cents: number | null;
  next_attempt_date:  string | null;
  profiles:          { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
  plans:             { plan_type: number | null; practices: { name: string } | { name: string }[] | null } | { plan_type: number | null; practices: { name: string } | { name: string }[] | null }[] | null;
};

function parseChip(raw: string | undefined): ChipKey {
  const validKeys = CHIP_DEFINITIONS.map(c => c.key);
  return (validKeys as string[]).includes(raw ?? '') ? (raw as ChipKey) : 'overdue';
}

function planType(row: PaymentRow): number | null {
  const plan = Array.isArray(row.plans) ? row.plans[0] : row.plans;
  return plan?.plan_type ?? null;
}

function planPracticeName(row: PaymentRow): string {
  const plan = Array.isArray(row.plans) ? row.plans[0] : row.plans;
  if (!plan) return '—';
  return practiceName(plan.practices);
}

function instalmentLabel(row: PaymentRow): string {
  const total = planType(row);
  if (!total) return `#${row.instalment_number}`;
  return `${row.instalment_number} of ${total}`;
}

// Friendly date-header label — "Today", "Yesterday", or full date with
// a leading "Overdue · " marker for past-due dates.
function dateLabel(date: string, today: string, isOverdue: boolean): string {
  if (date === today) return `Today · ${formatDateStr(date)}`;
  if (isOverdue)      return `Overdue · ${formatDateStr(date)}`;
  return formatDateStr(date);
}

export default async function AdminCollectionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin/collections' });

  // Layout-level admin auth is sufficient (app/admin/layout.tsx), but
  // belt-and-braces — repeat at the page level so a future change that
  // moves the route can't silently lose its guard.
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  const params = await searchParams;
  const chip   = parseChip(params.chip);
  const today  = new Date().toISOString().slice(0, 10);

  // Resolve the active range. Absent from/to params → chip default;
  // explicit empty strings → user-cleared (all-time). See
  // [[dateRange-test]] for the contract.
  const { from, to } = parseRangeParams({ from: params.from, to: params.to }, chip, today);
  const hasRange = Boolean(from || to);

  // Apply the range filter to a query builder. due_date is the lens
  // — operational basis. (The dashboard's "Collected this month" sums
  // by collected_at, which is a different lens. See report.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applyRange<Q extends { gte: any; lte: any }>(q: Q): Q {
    let out = q;
    if (from) out = out.gte('due_date', from);
    if (to)   out = out.lte('due_date', to);
    return out;
  }

  // Fetch the payments in the chip's bucket (or all). Each chip maps
  // to a deterministic query — we keep the mapping in one place
  // rather than letting the chip key sprawl across the query builder.
  let query = supabase
    .from('payments')
    .select(`
      id, plan_id, patient_id, instalment_number, amount, due_date,
      status, retry_count, collected_at, dunning_fees_cents, next_attempt_date,
      profiles!payments_patient_id_fkey(first_name, last_name),
      plans(plan_type, practices(name))
    `);

  switch (chip) {
    case 'overdue':
      query = query.eq('status', 'scheduled').lt('due_date', today);
      break;
    case 'upcoming':
      query = query.eq('status', 'scheduled').gte('due_date', today);
      break;
    case 'processing':
      query = query.eq('status', 'processing');
      break;
    case 'failed':
      query = query.in('status', ['failed', 'retried']);
      break;
    case 'defaulted':
      query = query.eq('status', 'defaulted');
      break;
    case 'collected':
      query = query.eq('status', 'collected');
      break;
    case 'written_off':
      query = query.eq('status', 'written_off');
      break;
    case 'all':
      // no extra filter
      break;
  }

  query = applyRange(query);

  // Row order doesn't matter to the rollup — we sort the rollups
  // themselves below. We still cap the rows so a misconfigured
  // chip can't blow up on a huge table.
  query = query.limit(2000);

  const { data: rawRows, error } = await query;
  if (error) {
    console.error('[admin/collections] query failed', error);
  }
  const rows = (rawRows ?? []) as unknown as PaymentRow[];

  // ── Counts per chip ──────────────────────────────────────────────────
  // Range-scoped — switching chips keeps the user's range, and the
  // chip counts reflect "how many in THIS range, per chip". Without
  // a range applied the counts go global (all-time).
  //
  // kind='instalment' so settlement rows (post-0058) don't conflate
  // with instalment health metrics. The DETAIL table above (the row
  // selection at applyRange/query) stays unfiltered so admins can
  // still see settlement rows for audit.
  let countsQuery = supabase.from('payments')
    .select('id, status, due_date')
    .eq('kind', 'instalment')
    .limit(50000);
  countsQuery = applyRange(countsQuery);
  const { data: rawAll } = await countsQuery;

  const counts: Record<ChipKey, number> = {
    overdue: 0, upcoming: 0, processing: 0, failed: 0, defaulted: 0, collected: 0, written_off: 0, all: 0,
  };
  for (const r of (rawAll ?? []) as Array<{ status: string; due_date: string }>) {
    const b = classifyCollection(r, today);
    counts[b]++;
    counts.all++;
  }

  // ── Awaiting reconciliation (audit A-13) ─────────────────────────────
  //
  // Rows the daily sweep found stuck in 'processing' and deliberately did
  // NOT touch, because a charge may be in flight: provider_attempted_at is
  // set, so the request reached Peach and the response never came back.
  //
  // The sweep cannot resolve these — the recurring surface of this Peach
  // client has no payment-status query, and reverting on a guess either
  // double-charges the customer (if Peach collected) or writes off the
  // balance (if it did not). The answer lives in the Peach dashboard, so
  // the row lives here, in front of the person who can look it up.
  //
  // Shown unconditionally, above the chips, on every chip. It is not a
  // filter of the collections view; it is the thing that used to be
  // invisible, and burying it behind a chip nobody clicks would leave it
  // that way. The list is empty and the block absent in normal operation.
  // new Date().getTime() rather than Date.now(): the react-hooks/purity rule
  // flags the latter, and this page already derives `today` the same way.
  const stuckCutoff = new Date(
    new Date().getTime() - STUCK_PROCESSING_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { data: rawStuck } = await supabase
    .from('payments')
    .select('id, amount, kind, plan_id, peach_payment_id, processing_since, failure_reason')
    .eq('status', 'processing')
    .not('provider_attempted_at', 'is', null)
    .lt('processing_since', stuckCutoff)
    .order('processing_since', { ascending: true })
    .limit(50);
  const stuckRows = (rawStuck ?? []) as Array<{
    id: string; amount: number; kind: string | null; plan_id: string | null;
    peach_payment_id: string | null; processing_since: string; failure_reason: string | null;
  }>;

  // ── Rollup by date ───────────────────────────────────────────────────
  const rollups = rollupByDate(rows, today, sortModeForChip(chip));

  const visibleTotal = rows.reduce((s, r) => s + Number(r.amount), 0);
  const periodLabel  = formatPeriodLabel(chip, from, to, today);

  // Only show the per-date status mix on the "all" chip — single-status
  // chips already have a uniform mix (overdue chip = all overdue, etc.)
  // and the breakdown is noise there.
  const showMix = chip === 'all';

  // Switching chips preserves the user's range — but when navigating
  // away from a chip that had a sensible default range to one whose
  // default differs, we want the URL to be honest. Strategy: if the
  // current range is the user's explicit choice (params present),
  // preserve it on chip links; if it's a chip default (params absent),
  // omit from/to from chip links so the next chip picks its own default.
  const userExplicit = params.from !== undefined || params.to !== undefined;
  function chipHref(key: ChipKey): string {
    const sp = new URLSearchParams();
    sp.set('chip', key);
    if (userExplicit) {
      sp.set('from', from);
      sp.set('to',   to);
    }
    return `/admin/collections?${sp.toString()}`;
  }

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">

      {/* Heading */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Collections</h1>
          <p className="mt-1 text-sm text-gray-500">
            Date-by-date view of the collection flow. Click a date to see its installments.
            <Link href="/admin/collections/cron" className="ml-2 text-[#15A89E] hover:text-[#13294B]">
              Cron health →
            </Link>
          </p>
        </div>
        <div className="text-right text-sm text-gray-700">
          <p className="font-medium text-gray-900">{periodLabel}</p>
          <p className="text-xs text-gray-500 tabular-nums mt-0.5">
            {rows.length} {rows.length === 1 ? 'row' : 'rows'} · {formatRand(visibleTotal)}
          </p>
        </div>
      </div>

      {/* Awaiting reconciliation — see the query above for why it is here
          and not behind a chip. */}
      {stuckRows.length > 0 && (
        <section className="rounded-2xl border border-red-300 bg-red-50 p-4 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-red-900">
              {stuckRows.length} payment{stuckRows.length === 1 ? '' : 's'} awaiting reconciliation
            </h2>
            <p className="mt-1 text-xs text-red-800">
              The charge reached the payment provider and no result came back. Nothing
              automated can resolve these — look each reference up in the Peach dashboard.
              If it collected, the webhook can be replayed; if it never existed, the claim
              can be released. Until then the balance they cover is not collectable.
            </p>
          </div>
          <ul className="space-y-1.5">
            {stuckRows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-lg bg-white/70 px-3 py-2 text-xs"
              >
                <Link
                  href={`/admin/collections/${row.id}`}
                  className="font-medium text-[#13294B] underline underline-offset-2"
                >
                  {row.kind === 'settlement' ? 'Full settlement' : 'Instalment'} · {formatRand(Number(row.amount))}
                </Link>
                <span className="font-mono text-gray-700">{row.peach_payment_id ?? 'no reference'}</span>
                <span className="text-gray-600">stuck since {formatDateTime(row.processing_since)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Range picker */}
      <div className="flex items-center gap-2">
        <CollectionsDateRangePicker from={from} to={to} />
        {hasRange && chip === 'overdue' && (
          <span className="text-xs text-gray-500">
            Range scopes overdue items by their <code>due_date</code> — clear to see all overdue regardless of when due.
          </span>
        )}
      </div>

      {/* Chips */}
      <div className="flex gap-2 flex-wrap">
        {CHIP_DEFINITIONS.map((def) => {
          const active = def.key === chip;
          const count  = counts[def.key];
          return (
            <Link
              key={def.key}
              href={chipHref(def.key)}
              title={def.description}
              className={
                'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium border transition-colors '
                + (active
                  ? 'border-[#15A89E] bg-[#15A89E]/10 text-[#15A89E]'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300')
              }
            >
              <span>{def.label}</span>
              <span className={'tabular-nums ' + (active ? 'text-[#15A89E]' : 'text-gray-400')}>
                {count}
              </span>
            </Link>
          );
        })}
      </div>

      {/* Rollups */}
      {rollups.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
          <p className="text-gray-500">
            No rows for <strong>{periodLabel}</strong>.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rollups.map((rollup) => (
            <DateRollupCard
              key={rollup.date}
              rollup={rollup}
              today={today}
              showMix={showMix}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Date rollup card ───────────────────────────────────────────────────────
//
// Server-rendered <details> disclosure. Click the summary to expand —
// no JS needed, fully accessible. Body holds the desktop table and
// mobile card list reused from the previous installment-level view.

function DateRollupCard({
  rollup, today, showMix,
}: {
  rollup:  DateRollup<PaymentRow>;
  today:   string;
  showMix: boolean;
}) {
  const isOverdue = rollup.tone === 'red';
  const isToday   = rollup.tone === 'amber';

  // Summary palette
  const wrap = isOverdue ? 'border-red-200'   : isToday ? 'border-amber-200'   : 'border-gray-200';
  const head = isOverdue ? 'bg-red-50'        : isToday ? 'bg-amber-50'        : 'bg-gray-50';
  const txt  = isOverdue ? 'text-red-900'     : isToday ? 'text-amber-900'     : 'text-gray-900';
  const sub  = isOverdue ? 'text-red-800'     : isToday ? 'text-amber-800'     : 'text-gray-500';

  return (
    <section className={`bg-white rounded-2xl border ${wrap} shadow-sm overflow-hidden`}>
      <details>
        {/* SUMMARY — the clickable date header */}
        <summary
          className={`px-4 sm:px-5 py-3 border-b ${wrap} ${head} cursor-pointer select-none list-none flex items-center justify-between gap-3`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Chevron />
            <h2 className={`text-sm font-semibold ${txt}`}>
              {dateLabel(rollup.date, today, isOverdue)}
            </h2>
          </div>
          <div className={`flex items-center gap-3 text-xs tabular-nums ${sub}`}>
            {showMix ? (
              <MixLine mix={rollup.mix} />
            ) : (
              <span>
                {rollup.count} · {formatRand(rollup.total)}
              </span>
            )}
          </div>
        </summary>

        {/* BODY — the installments for this date */}
        <DateBody rows={rollup.rows} today={today} />
      </details>
    </section>
  );
}

function Chevron() {
  // CSS-rotated chevron via the `details[open]` selector — pure-CSS
  // disclosure indicator, no JS.
  return (
    <span aria-hidden className="inline-block transition-transform [details[open]_&]:rotate-90 text-gray-400">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 6 15 12 9 18" />
      </svg>
    </span>
  );
}

function MixLine({ mix }: { mix: DateRollup<PaymentRow>['mix'] }) {
  // Render the bucket counts in chip-bar order so the eye reads the
  // same vocabulary in both places.
  const ORDER: Array<CollectionBucket> = [
    'overdue', 'processing', 'upcoming', 'failed', 'defaulted', 'collected', 'written_off',
  ];
  const parts = ORDER
    .filter(b => (mix[b] ?? 0) > 0)
    .map(b => `${mix[b]} ${BUCKET_MIX_LABEL[b]}`);
  return <span className="text-xs">{parts.join(' · ')}</span>;
}

function DateBody({ rows, today }: { rows: PaymentRow[]; today: string }) {
  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-white border-b border-gray-100">
            <tr>
              {['Patient', 'Practice', 'Instalment', 'Amount', 'Fees', 'Status', 'Retry', 'Next retry'].map((h) => (
                <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 whitespace-nowrap">
                  <Link href={`/admin/collections/${row.id}`} className="text-gray-900 hover:underline">
                    {fullName(row.profiles)}
                  </Link>
                </td>
                <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{planPracticeName(row)}</td>
                <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{instalmentLabel(row)}</td>
                <td className="px-4 py-3 text-gray-900 whitespace-nowrap tabular-nums">{formatRand(Number(row.amount))}</td>
                <td className="px-4 py-3 text-xs tabular-nums whitespace-nowrap">
                  {Number(row.dunning_fees_cents ?? 0) > 0
                    ? <span className="text-red-700">{formatRand(Number(row.dunning_fees_cents) / 100)}</span>
                    : <span className="text-gray-400">—</span>}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <Link href={`/admin/collections/${row.id}`} className="hover:opacity-80">
                    <CollectionStatusBadge bucket={classifyCollection(row, today)} />
                  </Link>
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 tabular-nums whitespace-nowrap">
                  {row.retry_count > 0 ? `${row.retry_count}` : '—'}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 tabular-nums whitespace-nowrap">
                  {row.next_attempt_date ? formatDateStr(row.next_attempt_date) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden divide-y divide-gray-100">
        {rows.map((row) => (
          <Link
            key={row.id}
            href={`/admin/collections/${row.id}`}
            className="block px-4 py-3 hover:bg-gray-50"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">
                  {fullName(row.profiles)}
                </p>
                <p className="text-xs text-gray-500 truncate">
                  {planPracticeName(row)} · {instalmentLabel(row)}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-semibold text-gray-900 tabular-nums">
                  {formatRand(Number(row.amount))}
                </p>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <CollectionStatusBadge bucket={classifyCollection(row, today)} />
              {row.retry_count > 0 && (
                <span className="text-xs text-gray-500">Retry {row.retry_count}</span>
              )}
            </div>
            {(Number(row.dunning_fees_cents ?? 0) > 0 || row.next_attempt_date) && (
              <div className="mt-1 flex items-center gap-3 text-xs text-gray-500">
                {Number(row.dunning_fees_cents ?? 0) > 0 && (
                  <span className="text-red-700">Fees {formatRand(Number(row.dunning_fees_cents) / 100)}</span>
                )}
                {row.next_attempt_date && (
                  <span>Next retry {formatDateStr(row.next_attempt_date)}</span>
                )}
              </div>
            )}
          </Link>
        ))}
      </div>
    </>
  );
}
