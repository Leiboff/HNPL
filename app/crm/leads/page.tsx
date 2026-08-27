import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import LeadsSearchForm from './LeadsSearchForm';
import LeadsListSection from './LeadsListSection';
import LeadsViewSwitcher from './LeadsViewSwitcher';
import SavedViewsBar from './SavedViewsBar';
import type { LeadScore } from '@/lib/crm/priorityScore';
import { SPECIALTIES } from '@/lib/specialties';
import { sastDayWindows } from '@/lib/crm/timezone';
import { computeLeadScore } from '@/lib/crm/priorityScore';
import { STAGES, TERMINAL_STAGES } from '@/lib/crm/stages';
import { INTERESTS, deriveLeadInterest, type Interest, type ContactForInterest } from '@/lib/crm/interest';
import { hasOnboardedPractitionerMatch } from '@/lib/crm/hpcsa';

// ─── /crm/leads — searchable lead list ────────────────────────────────
//
// House pattern: server-side search (ilike over practice_name / contact
// names / email / phone), server-side sort, stage/source/specialty
// filters. Sort + Filter controls live in LeadsListSection's toolbar
// sheets — hidden md:block table + mobile card list underneath.

const SOURCES = ['referral','cold_outreach','inbound','event','other'] as const;
type SortKey = 'follow-up' | 'updated' | 'created-desc' | 'value' | 'priority';
const SORTS: SortKey[] = ['follow-up', 'updated', 'created-desc', 'value', 'priority'];

type SearchParams = {
  q?: string;
  stage?: string;
  source?: string;
  specialty?: string;
  owner?: string;
  overdue?: string;
  interest?: string;
  hpcsaMatch?: string;
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
  const interest  = (INTERESTS as readonly string[]).includes(params.interest ?? '') ? (params.interest as Interest) : '';
  const hpcsaMatch = params.hpcsaMatch === 'true';
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
    .select('id, practice_name, contact_first_name, contact_last_name, phone, email, stage, source, specialty, suburb, city, next_follow_up_at, updated_at, created_at, estimated_monthly_billings, owner_user_id, latitude, longitude')
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
    // Nurture is excluded alongside the terminal stages: its
    // next_follow_up_at may still carry a stale value from before the
    // lead entered nurture, and nurture runs on nurture_wake_at instead
    // (see lib/crm/followups.ts) — without this every nurtured lead
    // would show as overdue here too.
    query = query.lt('next_follow_up_at', todayStartUtc.toISOString())
                 .not('next_follow_up_at', 'is', null)
                 .not('stage', 'in', `(${[...TERMINAL_STAGES, 'nurture'].join(',')})`);
  }

  const { data: rows } = await query;

  // ── Derived interest per lead — batch-fetch contacts, one query ────
  //
  // interest lives on crm_lead_contacts (0115), never on crm_leads, so
  // it can't be filtered/sorted server-side via the query above; it's
  // computed here and applied as a post-filter, same shape as the
  // owner-scoping the client-side map view already does.
  const leadIds = (rows ?? []).map(r => r.id);
  const interestByLead = new Map<string, Interest>();
  const hpcsaMatchByLead = new Map<string, boolean>();
  if (leadIds.length > 0) {
    const { data: contactRows } = await supabase
      .from('crm_lead_contacts')
      .select('lead_id, interest, is_decision_maker, hpcsa_group_key')
      .in('lead_id', leadIds);
    const grouped = new Map<string, ContactForInterest[]>();
    const hpcsaGrouped = new Map<string, Array<{ hpcsa_group_key: string | null }>>();
    for (const c of (contactRows ?? []) as Array<{ lead_id: string; interest: Interest; is_decision_maker: boolean; hpcsa_group_key: string | null }>) {
      const arr = grouped.get(c.lead_id) ?? [];
      arr.push({ interest: c.interest, is_decision_maker: c.is_decision_maker });
      grouped.set(c.lead_id, arr);
      const hArr = hpcsaGrouped.get(c.lead_id) ?? [];
      hArr.push({ hpcsa_group_key: c.hpcsa_group_key });
      hpcsaGrouped.set(c.lead_id, hArr);
    }
    for (const id of leadIds) interestByLead.set(id, deriveLeadInterest(grouped.get(id) ?? []));

    // "Practitioner already onboarded elsewhere" saved view (Change 5) —
    // a separate, broader query (not scoped to the current page's
    // leadIds) for every HPCSA key already at an onboarded practice.
    const { data: onboardedHpcsaRows } = await supabase
      .from('crm_lead_contacts')
      .select('hpcsa_group_key, crm_leads!inner(stage)')
      .not('hpcsa_group_key', 'is', null);
    const onboardedHpcsaKeys = new Set(
      ((onboardedHpcsaRows ?? []) as unknown as Array<{ hpcsa_group_key: string; crm_leads: { stage: string } | Array<{ stage: string }> }>)
        .filter(r => {
          const rel = Array.isArray(r.crm_leads) ? r.crm_leads[0] : r.crm_leads;
          return rel?.stage === 'onboarded';
        })
        .map(r => r.hpcsa_group_key),
    );
    for (const r of rows ?? []) {
      hpcsaMatchByLead.set(
        r.id,
        hasOnboardedPractitionerMatch(r.stage, hpcsaGrouped.get(r.id) ?? [], onboardedHpcsaKeys),
      );
    }
  }
  const interestFilteredRows = (rows ?? [])
    .filter(r => !interest || interestByLead.get(r.id) === interest)
    .filter(r => !hpcsaMatch || hpcsaMatchByLead.get(r.id));

  const { data: ownerRows } = await supabase
    .from('profiles')
    .select('id, first_name, last_name')
    .in('role', ['admin', 'sales'])
    .order('first_name');
  const owners = (ownerRows ?? []).map(o => ({ id: o.id, name: `${o.first_name} ${o.last_name}`.trim() }));

  const { data: cityRows } = await supabase.from('crm_leads').select('city').is('archived_at', null).not('city', 'is', null).limit(2000);
  const cities = Array.from(new Set((cityRows ?? []).map(r => r.city).filter(Boolean) as string[])).sort();

  const now = new Date();
  const scoresById = new Map(interestFilteredRows.map(r => [r.id, computeLeadScore({
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

  const sorted = [...interestFilteredRows].sort((a, b) => {
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
      </div>

      <LeadsListSection
        rows={sorted.map(r => ({ ...r, interest: interestByLead.get(r.id) ?? 'unknown' }))}
        owners={owners}
        scores={Object.fromEntries(scoresById) as Record<string, LeadScore>}
        specialties={SPECIALTIES}
        cities={cities}
        isAdmin={isAdmin}
        currentUserId={user.id}
      />
    </div>
  );
}
