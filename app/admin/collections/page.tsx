import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { formatRand, formatDateStr, fullName, practiceName } from '../_lib/format';
import CollectionStatusBadge, { classifyCollection, type CollectionBucket } from '../_components/CollectionStatusBadge';

// ─── /admin/collections ─────────────────────────────────────────────────────
//
// One page, filter chips, date-grouped rows. Each row drills into
// /admin/collections/[paymentId]. The active chip filter is in the
// URL as ?chip=overdue / awaiting / upcoming / failed / collected /
// written_off / all (default 'overdue' to surface what needs action
// first).
//
// status → chip mapping (from CollectionStatusBadge):
//   payments.status='processing'                          → awaiting
//   payments.status='scheduled' AND due_date <  today     → overdue
//   payments.status='scheduled' AND due_date >= today     → upcoming
//   payments.status='failed' (or 'retried')               → failed
//   payments.status='collected'                           → collected
//   payments.status='written_off'                         → written_off

type SearchParams = { chip?: string };

const CHIP_DEFINITIONS: Array<{
  key:         CollectionBucket | 'all';
  label:       string;
  description: string;
}> = [
  { key: 'overdue',     label: 'Overdue',             description: 'Scheduled, past due_date — cron should have picked these up' },
  { key: 'processing' as CollectionBucket,
                        label: 'Awaiting',            description: 'Charge fired, webhook not yet reconciled' },
  { key: 'upcoming',    label: 'Upcoming',            description: 'Scheduled, due in the future' },
  { key: 'failed',      label: 'Failed / retrying',   description: 'Failed under the retry cap' },
  { key: 'collected',   label: 'Collected',           description: 'Successfully collected' },
  { key: 'written_off', label: 'Written off',         description: 'Retry cap exhausted' },
  { key: 'all',         label: 'All',                 description: 'Every row' },
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
  profiles:          { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
  plans:             { plan_type: number | null; practices: { name: string } | { name: string }[] | null } | { plan_type: number | null; practices: { name: string } | { name: string }[] | null }[] | null;
};

function parseChip(raw: string | undefined): CollectionBucket | 'all' {
  const validKeys = CHIP_DEFINITIONS.map(c => c.key);
  return (validKeys as string[]).includes(raw ?? '') ? (raw as CollectionBucket | 'all') : 'overdue';
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

  // Fetch the payments in the chip's bucket (or all). Each chip maps
  // to a deterministic query — we keep the mapping in one place
  // rather than letting the chip key sprawl across the query builder.
  //
  // For chips that combine status + due_date (overdue, upcoming) we
  // filter by status='scheduled' and then by the date comparator.
  let query = supabase
    .from('payments')
    .select(`
      id, plan_id, patient_id, instalment_number, amount, due_date,
      status, retry_count, collected_at,
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

  // Sort by due_date for the date groupings. Collected uses
  // collected_at desc instead (most-recent first) — but we still keep
  // due_date as the group key for consistency.
  const ascSort = chip === 'overdue' || chip === 'upcoming' || chip === 'all';
  query = query.order('due_date', { ascending: ascSort }).limit(500);

  const { data: rawRows, error } = await query;
  if (error) {
    console.error('[admin/collections] query failed', error);
  }
  const rows = (rawRows ?? []) as unknown as PaymentRow[];

  // ── Counts per chip (one query, separate counts) ─────────────────────
  // The chip bar shows live counts so the admin can scan "what
  // needs my attention right now". We pull all rows once and bucket
  // them locally; on a real-world DB this'd be a small set in the
  // hundreds-of-thousands range tops.
  const { data: rawAll } = await supabase
    .from('payments')
    .select('id, status, due_date')
    .limit(50000);   // safety cap; collections volume is modest

  const counts: Record<CollectionBucket | 'all', number> = {
    overdue: 0, upcoming: 0, processing: 0, failed: 0, collected: 0, written_off: 0, all: 0,
  };
  for (const r of (rawAll ?? []) as Array<{ status: string; due_date: string }>) {
    const b = classifyCollection(r, today);
    counts[b]++;
    counts.all++;
  }

  // ── Group the visible rows by due_date for grouped sections ─────────
  // Overdue rows get a single "Overdue" header (group key 'overdue') so
  // an admin doesn't have to scan many group headers for late items.
  // Everything else groups by formatted due_date.
  type Group = { key: string; label: string; tone: 'red' | 'amber' | 'default'; rows: PaymentRow[]; total: number };
  const groups: Group[] = [];
  const indexByKey = new Map<string, number>();
  for (const row of rows) {
    const bucket = classifyCollection(row, today);
    let key: string;
    let label: string;
    let tone: 'red' | 'amber' | 'default';
    if (bucket === 'overdue') {
      key   = 'overdue';
      label = 'Overdue';
      tone  = 'red';
    } else if (row.due_date === today) {
      key   = today;
      label = `Today · ${formatDateStr(row.due_date)}`;
      tone  = 'amber';
    } else {
      key   = row.due_date;
      label = formatDateStr(row.due_date);
      tone  = 'default';
    }
    let idx = indexByKey.get(key);
    if (idx === undefined) {
      idx = groups.length;
      indexByKey.set(key, idx);
      groups.push({ key, label, tone, rows: [], total: 0 });
    }
    groups[idx].rows.push(row);
    groups[idx].total += Number(row.amount);
  }

  const visibleTotal = rows.reduce((s, r) => s + Number(r.amount), 0);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">

      {/* Heading */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Collections</h1>
          <p className="mt-1 text-sm text-gray-500">
            Every installment scheduled, in-flight, completed, or written off.
            <Link href="/admin/collections/cron" className="ml-2 text-[#15A89E] hover:text-[#13294B]">
              Cron health →
            </Link>
          </p>
        </div>
        <div className="text-right text-sm text-gray-500 tabular-nums">
          <span>{rows.length} row{rows.length === 1 ? '' : 's'}</span>
          <span className="mx-2">·</span>
          <span>{formatRand(visibleTotal)}</span>
        </div>
      </div>

      {/* Chips */}
      <div className="flex gap-2 flex-wrap">
        {CHIP_DEFINITIONS.map((def) => {
          const active = def.key === chip;
          const count  = counts[def.key];
          return (
            <Link
              key={def.key}
              href={`/admin/collections?chip=${def.key}`}
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

      {/* Grouped rows */}
      {rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
          <p className="text-gray-500">
            No collections in <strong>{CHIP_DEFINITIONS.find(c => c.key === chip)?.label}</strong>.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key} className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
              <div className={`px-4 sm:px-5 py-3 border-b flex items-center justify-between gap-3 ${
                group.tone === 'red'
                  ? 'bg-red-50 border-red-200'
                  : group.tone === 'amber'
                    ? 'bg-amber-50 border-amber-200'
                    : 'bg-gray-50 border-gray-200'
              }`}>
                <h2 className={`text-sm font-semibold ${
                  group.tone === 'red' ? 'text-red-900' :
                  group.tone === 'amber' ? 'text-amber-900' : 'text-gray-900'
                }`}>
                  {group.label}
                </h2>
                <div className={`text-xs tabular-nums ${
                  group.tone === 'red' ? 'text-red-800' :
                  group.tone === 'amber' ? 'text-amber-800' : 'text-gray-500'
                }`}>
                  {group.rows.length} · {formatRand(group.total)}
                </div>
              </div>

              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-white border-b border-gray-100">
                    <tr>
                      {['Patient', 'Practice', 'Instalment', 'Amount', 'Due', 'Status', 'Retry'].map((h) => (
                        <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {group.rows.map((row) => (
                      <tr key={row.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 whitespace-nowrap">
                          <Link href={`/admin/collections/${row.id}`} className="text-gray-900 hover:underline">
                            {fullName(row.profiles)}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{planPracticeName(row)}</td>
                        <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{instalmentLabel(row)}</td>
                        <td className="px-4 py-3 text-gray-900 whitespace-nowrap tabular-nums">{formatRand(Number(row.amount))}</td>
                        <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDateStr(row.due_date)}</td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <CollectionStatusBadge bucket={classifyCollection(row, today)} />
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 tabular-nums whitespace-nowrap">
                          {row.retry_count > 0 ? `${row.retry_count}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden divide-y divide-gray-100">
                {group.rows.map((row) => (
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
                        <p className="text-xs text-gray-500">{formatDateStr(row.due_date)}</p>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <CollectionStatusBadge bucket={classifyCollection(row, today)} />
                      {row.retry_count > 0 && (
                        <span className="text-xs text-gray-500">Retry {row.retry_count}</span>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
