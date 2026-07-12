import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { formatDateTime, formatRand } from '@/app/admin/_lib/format';
import LeadsSearchForm from './LeadsSearchForm';
import { SPECIALTIES } from '@/lib/specialties';
import { sastDayWindows } from '@/lib/crm/timezone';

// ─── /crm/leads — searchable lead list ────────────────────────────────
//
// House pattern: server-side search (ilike over practice_name / contact
// names / email / phone), sort chips (in-memory), stage/source/specialty
// filter chips. hidden md:block table + mobile card list.

const STAGES = ['new','contacted','meeting_scheduled','demo_done','agreement_sent','signed','onboarded','lost'] as const;
const SOURCES = ['referral','cold_outreach','inbound','event','other'] as const;
type SortKey = 'follow-up' | 'updated' | 'created-desc';
const SORTS: SortKey[] = ['follow-up', 'updated', 'created-desc'];
const SORT_LABEL: Record<SortKey, string> = {
  'follow-up':   'Next follow-up',
  'updated':     'Recently updated',
  'created-desc':'Newest first',
};

type SearchParams = {
  q?: string;
  stage?: string;
  source?: string;
  specialty?: string;
  owner?: string;
  overdue?: string;
  sort?: string;
};

function sanitizeQ(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9 @._\-+]/g, '').trim().slice(0, 60);
}
function parseSort(raw: string | undefined): SortKey {
  return (SORTS as string[]).includes(raw ?? '') ? (raw as SortKey) : 'follow-up';
}

export default async function LeadsListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user, supabase } = await requireConfirmedUser({ next: '/crm/leads' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'sales' && profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  const params = await searchParams;
  const q         = sanitizeQ(params.q);
  const stage     = STAGES.includes(params.stage as (typeof STAGES)[number]) ? params.stage : '';
  const source    = SOURCES.includes(params.source as (typeof SOURCES)[number]) ? params.source : '';
  const specialty = (SPECIALTIES as readonly string[]).includes(params.specialty ?? '') ? params.specialty : '';
  const overdue   = params.overdue === 'true';
  const sort      = parseSort(params.sort);

  let query = supabase
    .from('crm_leads')
    .select('id, practice_name, contact_first_name, contact_last_name, phone, email, stage, source, specialty, suburb, city, estimated_monthly_billings, next_follow_up_at, updated_at, created_at')
    .limit(500);

  if (q) {
    const like = `%${q}%`;
    query = query.or(
      `practice_name.ilike.${like},contact_first_name.ilike.${like},contact_last_name.ilike.${like},email.ilike.${like},phone.ilike.${like}`,
    );
  }
  if (stage)     query = query.eq('stage',     stage);
  if (source)    query = query.eq('source',    source);
  if (specialty) query = query.eq('specialty', specialty);
  if (overdue) {
    const { todayStartUtc } = sastDayWindows(new Date());
    query = query.lt('next_follow_up_at', todayStartUtc.toISOString())
                 .not('next_follow_up_at', 'is', null)
                 .not('stage', 'in', '(signed,onboarded,lost)');
  }

  const { data: rows } = await query;

  const sorted = [...(rows ?? [])].sort((a, b) => {
    switch (sort) {
      case 'follow-up':
        // Nulls last, ascending
        if (!a.next_follow_up_at && !b.next_follow_up_at) return 0;
        if (!a.next_follow_up_at) return 1;
        if (!b.next_follow_up_at) return -1;
        return a.next_follow_up_at.localeCompare(b.next_follow_up_at);
      case 'updated':
        return b.updated_at.localeCompare(a.updated_at);
      case 'created-desc':
        return b.created_at.localeCompare(a.created_at);
    }
  });

  function chipUrl(patch: Partial<SearchParams>) {
    const u = new URLSearchParams();
    const merged: SearchParams = { q, stage, source, specialty, sort, ...patch };
    if (merged.q)         u.set('q', merged.q);
    if (merged.stage)     u.set('stage', merged.stage);
    if (merged.source)    u.set('source', merged.source);
    if (merged.specialty) u.set('specialty', merged.specialty);
    if (merged.overdue)   u.set('overdue', 'true');
    if (merged.sort)      u.set('sort', merged.sort);
    return `/crm/leads?${u.toString()}`;
  }

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Leads</h1>
          <p className="mt-1 text-sm text-gray-500">
            Practices in the pipeline. Click a row to open its detail record.
          </p>
        </div>
        <Link href="/crm/leads/new" className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium">
          + New lead
        </Link>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
        <LeadsSearchForm initialQ={q} />

        {/* Sort chips */}
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-xs text-gray-500 uppercase tracking-wide">Sort:</span>
          {SORTS.map(s => {
            const active = s === sort;
            return (
              <Link
                key={s}
                href={chipUrl({ sort: s })}
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

        {/* Stage / source / specialty / overdue chips */}
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-xs text-gray-500 uppercase tracking-wide">Stage:</span>
          <ChipLink href={chipUrl({ stage: '' })}       active={!stage}          label="All" />
          {STAGES.map(s => (
            <ChipLink key={s} href={chipUrl({ stage: s })} active={stage === s} label={s.replace(/_/g, ' ')} capitalize />
          ))}
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-xs text-gray-500 uppercase tracking-wide">Source:</span>
          <ChipLink href={chipUrl({ source: '' })}      active={!source}         label="All" />
          {SOURCES.map(s => (
            <ChipLink key={s} href={chipUrl({ source: s })} active={source === s} label={s.replace('_', ' ')} capitalize />
          ))}
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-xs text-gray-500 uppercase tracking-wide">Specialty:</span>
          <ChipLink href={chipUrl({ specialty: '' })}   active={!specialty}      label="All" />
          {SPECIALTIES.map(s => (
            <ChipLink key={s} href={chipUrl({ specialty: s })} active={specialty === s} label={s} />
          ))}
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <ChipLink href={chipUrl({ overdue: overdue ? undefined : 'true' })} active={overdue} label="Overdue only" tone="danger" />
        </div>
      </div>

      {/* Empty */}
      {sorted.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
          <p className="text-gray-500">No leads match. Try clearing filters or creating a new lead.</p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {['Practice', 'Contact', 'Stage', 'Specialty', 'Est. R/mo', 'Next follow-up', 'Updated'].map(h => (
                      <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sorted.map(r => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link href={`/crm/leads/${r.id}`} className="text-gray-900 font-medium hover:underline">
                          {r.practice_name}
                        </Link>
                        {r.suburb && <div className="text-xs text-gray-500">{[r.suburb, r.city].filter(Boolean).join(', ')}</div>}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">
                        <div>{r.contact_first_name} {r.contact_last_name}</div>
                        {r.email && <div className="text-gray-500 truncate max-w-[220px]">{r.email}</div>}
                        {r.phone && <div className="text-gray-500">{r.phone}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs capitalize">
                          {r.stage.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">{r.specialty ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-700 tabular-nums whitespace-nowrap">
                        {r.estimated_monthly_billings ? formatRand(Number(r.estimated_monthly_billings)) : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {r.next_follow_up_at
                          ? new Date(r.next_follow_up_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' })
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {formatDateTime(r.updated_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {sorted.map(r => (
              <Link
                key={r.id}
                href={`/crm/leads/${r.id}`}
                className="block bg-white rounded-2xl border border-gray-200 shadow-sm p-4 hover:border-gray-300"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{r.practice_name}</p>
                    <p className="text-xs text-gray-500 truncate">{r.contact_first_name} {r.contact_last_name}</p>
                  </div>
                  <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs capitalize shrink-0">
                    {r.stage.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <p className="text-gray-400 uppercase tracking-wide text-[10px]">Specialty</p>
                    <p className="text-gray-900 truncate">{r.specialty ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 uppercase tracking-wide text-[10px]">Est. R/mo</p>
                    <p className="text-gray-900 tabular-nums">{r.estimated_monthly_billings ? formatRand(Number(r.estimated_monthly_billings)) : '—'}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 uppercase tracking-wide text-[10px]">Next</p>
                    <p className="text-gray-900 tabular-nums">
                      {r.next_follow_up_at
                        ? new Date(r.next_follow_up_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'short' })
                        : '—'}
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ChipLink({ href, active, label, capitalize, tone }: {
  href: string; active: boolean; label: string; capitalize?: boolean; tone?: 'danger';
}) {
  const activeCls =
    tone === 'danger' ? 'border-red-200 bg-red-50 text-red-800' : 'border-[#15A89E] bg-[#15A89E]/10 text-[#15A89E]';
  return (
    <Link
      href={href}
      className={
        'rounded-full px-3 py-1 text-xs font-medium border transition-colors '
        + (active ? activeCls : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300')
        + (capitalize ? ' capitalize' : '')
      }
    >
      {label}
    </Link>
  );
}
