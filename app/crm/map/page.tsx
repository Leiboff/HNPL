import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import MapClient from './MapClient';
import { sastDayWindows } from '@/lib/crm/timezone';
import { decodeFilters, applyLeadFilters } from '@/lib/crm/leadsFilterState';

// ─── /crm/map — territory-planning map ────────────────────────────────
//
// Server fetches every lead (cap 2000 — Phase 2 sales-team volume is
// far below), computes overdue-follow-up flags, and hands them to the
// client MapClient. The Google Maps JS API is loaded ONLY on this
// route (via a client-side script tag inside MapClient) so the rest
// of the CRM's bundle stays JS-lean.

export default async function CrmMapPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, supabase } = await requireConfirmedUser({ next: '/crm/map' });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'sales' && profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  const filters = decodeFilters(await searchParams);

  const { data: rawRows } = await supabase
    .from('crm_leads')
    .select('id, practice_name, contact_first_name, contact_last_name, phone, email, stage, source, specialty, owner_user_id, latitude, longitude, next_follow_up_at, suburb, city, province, formatted_address')
    .is('archived_at', null)
    .order('updated_at', { ascending: false })
    .limit(2000);

  const withTags = (rawRows ?? []).map(r => ({ ...r, tags: [] as string[], archived_at: null as string | null }));
  const rows = applyLeadFilters(withTags, { ...filters, tags: [] }, user.id);

  const { todayStartUtc } = sastDayWindows(new Date());
  const withCoords: MapLeadRow[] = [];
  const noCoords:   MapLeadRow[] = [];
  for (const raw of (rows ?? []) as Array<{
    id: string; practice_name: string; contact_first_name: string; contact_last_name: string;
    phone: string | null; email: string | null; stage: string; specialty: string | null;
    owner_user_id: string | null; latitude: number | string | null; longitude: number | string | null;
    next_follow_up_at: string | null; suburb: string | null; city: string | null; province: string | null;
    formatted_address: string | null;
  }>) {
    const lat = raw.latitude != null ? Number(raw.latitude) : null;
    const lng = raw.longitude != null ? Number(raw.longitude) : null;
    const overdueFollowup =
      !!raw.next_follow_up_at &&
      new Date(raw.next_follow_up_at) < todayStartUtc &&
      raw.stage !== 'signed' && raw.stage !== 'onboarded' && raw.stage !== 'lost';
    const row: MapLeadRow = {
      id:                raw.id,
      practiceName:      raw.practice_name,
      contactName:       `${raw.contact_first_name} ${raw.contact_last_name}`.trim(),
      phone:             raw.phone,
      email:             raw.email,
      stage:             raw.stage,
      specialty:         raw.specialty,
      ownerUserId:       raw.owner_user_id,
      lat, lng,
      nextFollowUpAt:    raw.next_follow_up_at,
      overdueFollowup,
      suburbCity:        [raw.suburb, raw.city].filter(Boolean).join(', ') || raw.formatted_address || '',
    };
    if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
      withCoords.push(row);
    } else {
      noCoords.push(row);
    }
  }

  return (
    <MapClient
      withCoords={withCoords}
      noCoords={noCoords}
      apiKey={process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY ?? ''}
    />
  );
}

export type MapLeadRow = {
  id:              string;
  practiceName:    string;
  contactName:     string;
  phone:           string | null;
  email:           string | null;
  stage:           string;
  specialty:       string | null;
  ownerUserId:     string | null;
  lat:             number | null;
  lng:             number | null;
  nextFollowUpAt:  string | null;
  overdueFollowup: boolean;
  suburbCity:      string;
};
