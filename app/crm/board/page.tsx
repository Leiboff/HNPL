import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import BoardClient from './BoardClient';
import { decodeFilters, applyLeadFilters } from '@/lib/crm/leadsFilterState';

// ─── /crm/board — Kanban by stage ─────────────────────────────────────
//
// Board and Map are faces of the same Leads surface as /crm/leads (see
// LeadsViewSwitcher) — they read the SAME filter querystring and apply
// it server-side via applyLeadFilters, so switching views never loses
// the filter. Tag filtering is list-only for now (would need an extra
// crm_lead_tags join here); every other dimension (search, stage,
// source, specialty, city, suburb, owner) applies identically.
//
// One column per stage; drag-to-move. Server fetches the full board
// dataset in one query (up to 2000 rows — Phase 1 sales team volume is
// well under).

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, supabase } = await requireConfirmedUser({ next: '/crm/board' });

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

  const filters = decodeFilters(await searchParams);

  const { data: rows } = await supabase
    .from('crm_leads')
    .select('id, practice_name, stage, contact_first_name, contact_last_name, next_follow_up_at, specialty, estimated_monthly_billings, source, city, suburb, owner_user_id, archived_at')
    .is('archived_at', null)
    .order('updated_at', { ascending: false })
    .limit(2000);

  const withTags = (rows ?? []).map(r => ({ ...r, tags: [] as string[] }));
  const filtered = applyLeadFilters(withTags, { ...filters, tags: [] }, user.id);

  return <BoardClient rows={filtered} resultCount={filtered.length} />;
}
