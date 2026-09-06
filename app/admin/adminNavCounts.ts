import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminCounts } from './adminNavLinks';

// ─── The admin nav's badge counts, in one place ────────────────────────
//
// Companion to ./adminNavLinks: that file is the single source for WHICH
// links the admin nav carries, this one for the numbers beside them.
//
// It exists because the admin nav is no longer rendered only by
// app/admin/layout.tsx. The /crm shell renders it too (for admins — see
// app/crm/layout.tsx), and a second hand-copied count query is the same
// divergence bug adminNavLinks.ts was written to kill: the sidebar and
// the menu would eventually disagree about how many payouts are pending.
//
// SupabaseClient generics are heavy and the helper only reaches for
// .from().select(), so the client is loosely typed at the boundary —
// same call as lib/auth/requireConfirmedUser.ts makes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = SupabaseClient<any, 'public', any>;

/**
 * Three head-only counts (no rows fetched) for the admin nav badges.
 * Runs under the CALLER's client, so it is subject to the same RLS as
 * the page — every caller is behind an admin gate already.
 */
export async function getAdminNavCounts(supabase: Client): Promise<AdminCounts> {
  const todayStr = new Date().toISOString().slice(0, 10);

  const [
    { count: pendingPractices },
    { count: overdueCollections },
    { count: pendingPayouts },
  ] = await Promise.all([
    supabase.from('practices').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    // Overdue = scheduled past due_date (cron hasn't picked up yet).
    // kind='instalment' so a settlement row (post-0058) never inflates
    // the sidebar badge — settlement rows are administrative artifacts,
    // not instalments needing collection.
    supabase.from('payments').select('*', { count: 'exact', head: true })
      .eq('kind', 'instalment')
      .eq('status', 'scheduled').lt('due_date', todayStr),
    supabase.from('payouts').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);

  return {
    pendingPractices:    pendingPractices    ?? 0,
    overdueCollections:  overdueCollections  ?? 0,
    pendingPayouts:      pendingPayouts      ?? 0,
  };
}
