import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import LeadsSearchForm from './LeadsSearchForm';
import LeadsResultsList from './LeadsResultsList';
import LeadsViewSwitcher from './LeadsViewSwitcher';
import SavedViewsBar from './SavedViewsBar';
import type { LeadScore } from '@/lib/crm/priorityScore';
import { SPECIALTIES } from '@/lib/specialties';
import { sastDayWindows } from '@/lib/crm/timezone';
import { computeLeadScore } from '@/lib/crm/priorityScore';

// ─── /crm/leads — searchable lead list ────────────────────────────────
//
// House pattern: server-side search (ilike over practice_name / contact
// names / email / phone), sort chips (in-memory), stage/source/specialty
// filter chips. hidden md:block table + mobile card list.

const STAGES = ['new','contacted','meeting_scheduled','demo_done','agreement_sent','signed','onboarded','lost'] as const;
const SOURCES = ['referral','cold_outreach','inbound','event','other'] as const;
type SortKey = 'follow-up' | 'updated' | 'created-desc' | 'value' | 'priority';
const SORTS: SortKey[] = ['follow-up', 'updated', 'created-desc', 'value', 'priority'];
const SORT_LABEL: Record<SortKey, string> = {
  'follow-up':   'Next follow-up',
  'updated':     'Recently updated',
  'created-desc':'Newest first',
  'value':       'Value',
  'priority':    'Priority',
};

type SearchParams = {
  q?: string;
  stage?: string;
  source?: string;
  specialty?: string;
  owner?: string;
  overdue?: string;
  sort?: string;
  city?: string;
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
  const isAdmin   = profile?.role === 'admin';
  // "My leads" is trivially true for sales under owner-scoped RLS — they
  // can only ever see their own rows. The owner filter is really an
  // admin tool for viewing one salesperson's book; ?owner=me still
  // works for admin as "show only what I personally own".
  const owner     = isAdmin ? (params.owner ?? '') : '';
  const city      = (params.city ?? '').trim().slice(0, 60);

  let query = supabase
    .from('crm_leads')
    .select('id, practice_name, contact_first_name, contact_last_name, phone, email, stage, source, specialty, suburb, city, next_follow_up_at, updated_at, created_at, estimated_monthly_billings, owner_user_id')
    .is('archived_at', null)
    .limit(500);
  if (owner === 'me') query = query.eq('owner_user_id', user.id);
  else if (owner)     query = query.eq('owner_user_id', owner);

  if (q) {
    const like = `%${q}%`;
    // Extend the search to additional contacts: pre-fetch matching
    // lead_ids from crm_lead_contacts so the .or below finds leads
    // whose non-primary contact matches. The primary contact already
    // matches via the mirrored crm_leads columns.
    const { data: contactHits } = await supabase
      .from('crm_lead_contacts')
      .select('lead_id')
      .or(
        `first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like},phone.ilike.${like}`,
      )
      .limit(500);
    const extraLeadIds = Array.from(
      new Set(((contactHits ?? []) as Array<{ lead_id: string }>).map(r => r.lead_id)),
    );
    const orClauses = [
      `practice_name.ilike.${like}`,
      `contact_first_name.ilike.${like}`,
      `contact_last_name.ilike.${like}`,
      `email.ilike.${like}`,
      `phone.ilike.${like}`,
    ];
    if (extraLeadIds.length > 0) {
      orClauses.push(`id.in.(${extraLeadIds.join(',')})`);
    }
    query = query.or(orClauses.join(','));
  }
  if (stage)     query = query.eq('stage',     stage);
  if (source)    query = query.eq('source',    source);
  if (specialty) query = query.eq('specialty', specialty);
  if (city)      query = query.eq('city',      city);
  if (overdue) {
    const { todayStartUtc } = sastDayWindows(new Date());
    query = query.lt('next_follow_up_at', todayStartUtc.toISOString())
                 .not('next_follow_up_at', 'is', null)
                 .not('stage', 'in', '(signed,onboarded,lost)');
  }

  const { data: rows } = await query;

  const { data: ownerRows } = await supabase
    .from('profiles')
    .select('id, first_name, last_name')
    .in('role', ['admin', 'sales'])
    .order('first_name');
  const owners = (ownerRows ?? []).map(o => ({ id: o.id, name: `${o.first_name} ${o.last_name}`.trim() }));

  const { data: cityRows } = await supabase.from('crm_leads').select('city').is('archived_at', null).not('city', 'is', null).limit(2000);
  const cities = Array.from(new Set((cityRows ?? []).map(r => r.city).filter(Boolean) as string[])).sort();

  const now = new Date();
  const scoresById = new Map((rows ?? []).map(r => [r.id, computeLeadScore({
    stage: r.stage,
    estimatedMonthlyBillings: r.estimated_monthly_billings,
    nextFollowUpAt: r.next_follow_up_at,
    // updated_at is the closest available proxy for "last stage change"
    // without an extra crm_activities join — a real per-lead stage-change
    // timestamp is a reasonable future upgrade, not required by Phase 3.
    lastStageChangeAt: r.updated_at,
    lastActivityAt: r.updated_at,
    hasUnansweredReply: false,
    distanceKm: null,
  }, now)]));

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
      case 'value':
        return (b.estimated_monthly_billings ?? 0) - (a.estimated_monthly_billings ?? 0);
      case 'priority':
        return (scoresById.get(b.id)?.score ?? 0) - (scoresById.get(a.id)?.score ?? 0);
    }
  });

  function chipUrl(patch: Partial<SearchParams>) {
    const u = new URLSearchParams();
    const merged: SearchParams = { q, stage, source, specialty, sort, owner, city, ...patch };
    if (merged.q)         u.set('q', merged.q);
    if (merged.stage)     u.set('stage', merged.stage);
    if (merged.source)    u.set('source', merged.source);
    if (merged.specialty) u.set('specialty', merged.specialty);
    if (merged.overdue)   u.set('overdue', 'true');
    if (merged.sort)      u.set('sort', merged.sort);
    if (merged.owner)     u.set('owner', merged.owner);
    if (merged.city)      u.set('city', merged.city);
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
        <div className="flex items-center gap-2">
          <LeadsViewSwitcher />
          <Link href="/crm/leads/new" className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium">
            + New lead
          </Link>
        </div>
      </div>
      <p className="text-xs text-gray-500" data-testid="leads-result-count">
        {sorted.length} lead{sorted.length === 1 ? '' : 's'}
      </p>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
        <LeadsSearchForm initialQ={q} />
        <SavedViewsBar params={params} />

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

        {/* Everything else lives behind Filters — the pill wall used to be
            ~250px above the fold across four rows; this collapses it to one
            row plus a single disclosure toggle. */}
        <details className="group" data-testid="leads-filters-disclosure">
          <summary className="cursor-pointer text-xs font-medium text-[#15A89E] list-none inline-flex items-center gap-1">
            Filters
            {(stage || source || specialty || overdue || owner || city) && (
              <span className="inline-flex items-center justify-center rounded-full bg-[#15A89E]/15 text-[#0F766E] text-[10px] font-bold px-1.5 py-0.5 min-w-[1.1rem]">
                {[stage, source, specialty, overdue ? '1' : '', owner, city].filter(Boolean).length}
              </span>
            )}
            <span className="text-gray-400 group-open:rotate-180 transition-transform">▾</span>
          </summary>
          <div className="mt-3 space-y-3">
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
            {cities.length > 0 && (
              <div className="flex gap-2 flex-wrap items-center">
                <span className="text-xs text-gray-500 uppercase tracking-wide">City:</span>
                <ChipLink href={chipUrl({ city: '' })} active={!city} label="All" />
                {cities.map(c => (
                  <ChipLink key={c} href={chipUrl({ city: c })} active={city === c} label={c} />
                ))}
              </div>
            )}
            {isAdmin && owners.length > 0 && (
              <div className="flex gap-2 flex-wrap items-center">
                <span className="text-xs text-gray-500 uppercase tracking-wide">Owner:</span>
                <ChipLink href={chipUrl({ owner: '' })}   active={!owner}        label="All" />
                <ChipLink href={chipUrl({ owner: 'me' })} active={owner === 'me'} label="My leads" />
                {owners.filter(o => o.id !== user.id).map(o => (
                  <ChipLink key={o.id} href={chipUrl({ owner: o.id })} active={owner === o.id} label={o.name} />
                ))}
              </div>
            )}
          </div>
        </details>
      </div>

      {/* Empty */}
      {sorted.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
          <p className="text-gray-500">No leads match. Try clearing filters or creating a new lead.</p>
        </div>
      ) : (
        <LeadsResultsList
          rows={sorted}
          owners={owners}
          scores={Object.fromEntries(scoresById) as Record<string, LeadScore>}
        />
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
