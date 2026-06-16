import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { formatRand, formatDateStr } from '../_lib/format';
import {
  computeReliability,
  formatPercent,
  type PlanRow as ReliPlan,
  type PaymentRow as ReliPayment,
} from './_lib/reliability';
import {
  computeStanding,
  STANDING_DISPLAY,
  type Standing,
} from '../_lib/standing';
import CustomersSearchForm from './CustomersSearchForm';

// ─── /admin/customers ───────────────────────────────────────────────────────
//
// Patient list — first half of Customer 360. Search by name / email /
// phone (server-side), sort by outstanding amount or signup date, drill
// into the per-patient record at /admin/customers/[id].
//
// Aggregates are computed in two batched queries (one for plans, one for
// payments) keyed by the visible patient_id set — avoiding N+1 loops.

type SearchParams = { q?: string; sort?: string };

type SortKey = 'signup-desc' | 'signup-asc' | 'outstanding-desc' | 'outstanding-asc';
const SORT_KEYS: SortKey[] = ['signup-desc', 'signup-asc', 'outstanding-desc', 'outstanding-asc'];
const SORT_LABEL: Record<SortKey, string> = {
  'signup-desc':      'Newest first',
  'signup-asc':       'Oldest first',
  'outstanding-desc': 'Most outstanding',
  'outstanding-asc':  'Least outstanding',
};

function parseSort(raw: string | undefined): SortKey {
  return (SORT_KEYS as string[]).includes(raw ?? '') ? (raw as SortKey) : 'signup-desc';
}

// Sanitize the user-typed search query before passing it to PostgREST's
// `.or()` filter — commas, parens, asterisks all break that filter's
// syntax. Whitelist letters / digits / spaces / @ . _ - + and clamp
// length. Empty after sanitization = no search.
function sanitizeQ(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9 @._\-+]/g, '').trim().slice(0, 60);
}

type ProfileRow = {
  id:         string;
  first_name: string;
  last_name:  string;
  email:      string;
  phone:      string | null;
  created_at: string;
};

export default async function AdminCustomersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin/customers' });

  // Layout already runs the admin-role check (app/admin/layout.tsx); we
  // repeat it here so a future change that moves the route can't drop
  // the guard silently. [[admin-auth-regression]]
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
  const q      = sanitizeQ(params.q);
  const sort   = parseSort(params.sort);
  const today  = new Date().toISOString().slice(0, 10);

  // ── 1. Profiles in the patient bucket, server-side filtered by q ───────
  // ILIKE against each searchable column; the .or() builder takes a
  // comma-separated list. PostgREST returns the union — natural
  // "OR" semantics across name / email / phone.
  let patientQuery = supabase
    .from('profiles')
    .select('id, first_name, last_name, email, phone, created_at')
    .eq('role', 'patient');

  if (q) {
    const like = `%${q}%`;
    patientQuery = patientQuery.or(
      `first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like},phone.ilike.${like}`,
    );
  }

  // Always cap at 250 rows. Without a hard limit the page can fall over
  // if the patient table grows large; with a search query the cap is
  // far more generous than typical match volume. Future: cursor pagination.
  patientQuery = patientQuery.order('created_at', { ascending: false }).limit(250);

  const { data: rawProfiles, error: profilesErr } = await patientQuery;
  if (profilesErr) {
    console.error('[admin/customers] patient query failed', profilesErr);
  }
  const profiles = (rawProfiles ?? []) as ProfileRow[];
  const patientIds = profiles.map(p => p.id);

  // ── 2. Batch-fetch plans + payments for ALL visible patients in two
  //       round trips, keyed by patient_id. Then group in-memory. ───────
  type PlanAgg = ReliPlan & { id: string; patient_id: string };
  type PaymentAgg = ReliPayment & { id: string; patient_id: string | null };

  let plansByPatient:    Map<string, PlanAgg[]>    = new Map();
  let paymentsByPatient: Map<string, PaymentAgg[]> = new Map();

  if (patientIds.length > 0) {
    const [{ data: rawPlans }, { data: rawPayments }] = await Promise.all([
      supabase
        .from('plans')
        .select('id, patient_id, total_amount, status')
        .in('patient_id', patientIds),
      supabase
        .from('payments')
        .select('id, patient_id, amount, status, due_date, retry_count, instalment_number')
        .in('patient_id', patientIds),
    ]);

    for (const raw of (rawPlans ?? []) as PlanAgg[]) {
      const list = plansByPatient.get(raw.patient_id) ?? [];
      list.push(raw);
      plansByPatient.set(raw.patient_id, list);
    }
    for (const raw of (rawPayments ?? []) as PaymentAgg[]) {
      if (!raw.patient_id) continue;
      const list = paymentsByPatient.get(raw.patient_id) ?? [];
      list.push(raw);
      paymentsByPatient.set(raw.patient_id, list);
    }
  }

  // ── 3. Per-row computed shape for the table ─────────────────────────────
  type Display = {
    profile:           ProfileRow;
    activePlans:       number;
    standing:          Standing;
    outstanding:       number;
    reliabilityRate:   number | null;
    salaryDateDue:     number;
  };

  const ACTIVE_PLAN_STATUSES = new Set(['active', 'pending_first_payment']);

  const rows: Display[] = profiles.map((profile) => {
    const ps   = plansByPatient.get(profile.id)    ?? [];
    const pays = paymentsByPatient.get(profile.id) ?? [];
    const r    = computeReliability(ps, pays, today);
    return {
      profile,
      activePlans:     ps.filter(pl => ACTIVE_PLAN_STATUSES.has(pl.status)).length,
      standing:        computeStanding(r),
      outstanding:     r.total_outstanding,
      reliabilityRate: r.reliability_rate,
      salaryDateDue:   r.salary_date_due_count,
    };
  });

  // ── 4. Sort the in-memory rows ──────────────────────────────────────────
  rows.sort((a, b) => {
    switch (sort) {
      case 'signup-desc':      return b.profile.created_at.localeCompare(a.profile.created_at);
      case 'signup-asc':       return a.profile.created_at.localeCompare(b.profile.created_at);
      case 'outstanding-desc': return b.outstanding - a.outstanding;
      case 'outstanding-asc':  return a.outstanding - b.outstanding;
    }
  });

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">

      {/* Heading */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Customers</h1>
          <p className="mt-1 text-sm text-gray-500">
            Every patient on the platform. Click into one for the full record:
            plans, payment history, cards, standing.
          </p>
        </div>
        <div className="text-right text-sm text-gray-500 tabular-nums">
          {rows.length} {rows.length === 1 ? 'customer' : 'customers'}
          {q && <span className="ml-2">matching <strong>"{q}"</strong></span>}
        </div>
      </div>

      {/* Search + sort */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
        <CustomersSearchForm initialQ={q} />
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-xs text-gray-500 uppercase tracking-wide">Sort:</span>
          {SORT_KEYS.map((s) => {
            const active = s === sort;
            const url = new URLSearchParams();
            if (q) url.set('q', q);
            url.set('sort', s);
            return (
              <Link
                key={s}
                href={`/admin/customers?${url.toString()}`}
                className={
                  'rounded-full px-3 py-1 text-xs font-medium border transition-colors '
                  + (active
                    ? 'border-[#15A89E] bg-[#15A89E]/10 text-[#15A89E]'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300')
                }
              >
                {SORT_LABEL[s]}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Empty state */}
      {rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
          <p className="text-gray-500">
            {q
              ? <>No customers match <strong>&ldquo;{q}&rdquo;</strong>.</>
              : <>No customers on the platform yet.</>
            }
          </p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {['Name', 'Contact', 'Active plans', 'Outstanding', 'On-time', 'Standing', 'Signed up'].map((h) => (
                      <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((r) => {
                    const standing = STANDING_DISPLAY[r.standing];
                    return (
                      <tr key={r.profile.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 whitespace-nowrap">
                          <Link
                            href={`/admin/customers/${r.profile.id}`}
                            className="text-gray-900 font-medium hover:underline"
                          >
                            {r.profile.first_name} {r.profile.last_name}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-gray-600 text-xs">
                          <div className="truncate max-w-[220px]">{r.profile.email}</div>
                          {r.profile.phone && <div className="text-gray-500">{r.profile.phone}</div>}
                        </td>
                        <td className="px-4 py-3 text-gray-700 tabular-nums whitespace-nowrap">
                          {r.activePlans > 0 ? r.activePlans : '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-900 tabular-nums whitespace-nowrap font-semibold">
                          {r.outstanding > 0 ? formatRand(r.outstanding) : '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-700 tabular-nums whitespace-nowrap">
                          {formatPercent(r.reliabilityRate)}
                          {r.salaryDateDue > 0 && <span className="text-xs text-gray-400 ml-1">({r.salaryDateDue})</span>}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${standing.cls}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${standing.dot}`} aria-hidden />
                            {standing.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                          {formatDateStr(r.profile.created_at.slice(0, 10))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {rows.map((r) => {
              const standing = STANDING_DISPLAY[r.standing];
              return (
                <Link
                  key={r.profile.id}
                  href={`/admin/customers/${r.profile.id}`}
                  className="block bg-white rounded-2xl border border-gray-200 shadow-sm p-4 hover:border-gray-300"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">
                        {r.profile.first_name} {r.profile.last_name}
                      </p>
                      <p className="text-xs text-gray-500 truncate mt-0.5">{r.profile.email}</p>
                      {r.profile.phone && <p className="text-xs text-gray-500 truncate">{r.profile.phone}</p>}
                    </div>
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium shrink-0 ${standing.cls}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${standing.dot}`} aria-hidden />
                      {standing.label}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <p className="text-gray-400 uppercase tracking-wide text-[10px]">Active</p>
                      <p className="text-gray-900 font-semibold tabular-nums">{r.activePlans > 0 ? r.activePlans : '—'}</p>
                    </div>
                    <div>
                      <p className="text-gray-400 uppercase tracking-wide text-[10px]">Outstanding</p>
                      <p className="text-gray-900 font-semibold tabular-nums">{r.outstanding > 0 ? formatRand(r.outstanding) : '—'}</p>
                    </div>
                    <div>
                      <p className="text-gray-400 uppercase tracking-wide text-[10px]">On-time</p>
                      <p className="text-gray-900 font-semibold tabular-nums">{formatPercent(r.reliabilityRate)}</p>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
