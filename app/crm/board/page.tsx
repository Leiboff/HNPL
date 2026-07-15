import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import BoardClient from './BoardClient';

// ─── /crm/board — Kanban by stage ─────────────────────────────────────
//
// One column per stage; drag-to-move. Column totals show lead count.
// Server fetches the full board dataset in one query (up to 2000 rows
// — Phase 1 sales team volume is well under).

export default async function BoardPage() {
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

  const { data: rows } = await supabase
    .from('crm_leads')
    .select('id, practice_name, stage, contact_first_name, contact_last_name, next_follow_up_at, specialty')
    .order('updated_at', { ascending: false })
    .limit(2000);

  return <BoardClient rows={rows ?? []} />;
}
