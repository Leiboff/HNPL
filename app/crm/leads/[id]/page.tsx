import { notFound, redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import LeadDetailClient from './LeadDetailClient';

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

  return (
    <LeadDetailClient
      lead={lead}
      activities={activities ?? []}
      actorsById={actorsById}
      pendingInvite={pendingInvite ?? null}
    />
  );
}
