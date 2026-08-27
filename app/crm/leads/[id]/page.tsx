import { notFound, redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import LeadDetailClient from './LeadDetailClient';
import { getAddressSuggestions } from './addressSuggestions';

// ─── /crm/leads/[id] — lead detail ────────────────────────────────────
//
// All fields editable in-place. Activity timeline newest first. Quick-add
// buttons for logging touches, scheduling calls/meetings, marking signed.

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user, supabase } = await requireConfirmedUser({ next: `/crm/leads/${id}` });

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

  const { data: lead } = await supabase
    .from('crm_leads')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!lead) notFound();

  const { data: activities } = await supabase
    .from('crm_activities')
    .select('id, type, title, body, occurred_at, created_at, created_by, sent_from, reply_from, gmail_thread_id, gmail_message_id')
    .eq('lead_id', id)
    .order('occurred_at', { ascending: false })
    .limit(200);

  // Resolve author display names for the timeline attribution row.
  const actorIds = Array.from(new Set(
    (activities ?? []).map(a => (a as { created_by: string | null }).created_by).filter(Boolean) as string[],
  ));
  const actorsById: Record<string, { firstName: string | null; lastName: string | null }> = {};
  if (actorIds.length > 0) {
    const { data: actors } = await supabase
      .from('profiles')
      .select('id, first_name, last_name')
      .in('id', actorIds);
    for (const p of (actors ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
      actorsById[p.id] = { firstName: p.first_name, lastName: p.last_name };
    }
  }

  // Optional: pending practice invitation for this lead
  const { data: pendingInvite } = await supabase
    .from('practice_invitations')
    .select('token, expires_at, accepted_at, accepted_by_practice_id')
    .eq('lead_id', id)
    .order('invited_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: contacts } = await supabase
    .from('crm_lead_contacts')
    .select('id, lead_id, first_name, last_name, role_at_practice, phone, email, is_primary, interest, is_decision_maker, hpcsa_number, hpcsa_group_key, notes, created_at, updated_at')
    .eq('lead_id', id)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true });

  // "This practitioner also appears at" — one query per lead, only
  // when at least one contact has an HPCSA on file (0118).
  const hpcsaKeys = Array.from(new Set(
    (contacts ?? []).map(c => c.hpcsa_group_key).filter((k): k is string => !!k),
  ));
  let practitionerAlsoAt: Array<{ leadId: string; practiceName: string }> = [];
  if (hpcsaKeys.length > 0) {
    const { data: otherContacts } = await supabase
      .from('crm_lead_contacts')
      .select('lead_id, hpcsa_group_key, crm_leads!inner(id, practice_name, archived_at)')
      .in('hpcsa_group_key', hpcsaKeys)
      .neq('lead_id', id);
    type OtherRow = { lead_id: string; crm_leads: { id: string; practice_name: string; archived_at: string | null } | Array<{ id: string; practice_name: string; archived_at: string | null }> };
    const seen = new Set<string>();
    for (const raw of (otherContacts ?? []) as unknown as OtherRow[]) {
      const rel = Array.isArray(raw.crm_leads) ? raw.crm_leads[0] : raw.crm_leads;
      if (!rel || rel.archived_at || seen.has(rel.id)) continue;
      seen.add(rel.id);
      practitionerAlsoAt.push({ leadId: rel.id, practiceName: rel.practice_name });
    }
  }

  const { data: ownerRows } = await supabase
    .from('profiles')
    .select('id, first_name, last_name')
    .in('role', ['admin', 'sales'])
    .order('first_name');
  const owners = (ownerRows ?? []).map(o => ({ id: o.id, name: `${o.first_name} ${o.last_name}`.trim() }));

  const addressSuggestions = await getAddressSuggestions(id);

  return (
    <LeadDetailClient
      lead={lead}
      activities={activities ?? []}
      contacts={(contacts ?? []) as never}
      actorsById={actorsById}
      pendingInvite={pendingInvite ?? null}
      owners={owners}
      addressSuggestions={addressSuggestions}
      practitionerAlsoAt={practitionerAlsoAt}
    />
  );
}
