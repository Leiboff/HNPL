import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import GmailAccountsAdminTable, { type AdminGmailAccountRow } from './GmailAccountsAdminTable';

// ─── /crm/admin/gmail-accounts — admin-only oversight ────────────────
//
// Lists every connected Gmail account across the org. Admin can revoke
// any row (Google token revocation + users.stop + row delete + audit).
// RLS on crm_email_accounts is deny-all to session clients — we read
// through the service role AFTER the admin role check.

export const dynamic = 'force-dynamic';

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export default async function GmailAccountsAdminPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/crm/admin/gmail-accounts' });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'admin') {
    // Sales users are NOT allowed here — this is the org-wide oversight
    // surface. Bounce them to their own settings.
    if (profile?.role === 'sales') redirect('/crm/settings');
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  const s = svc();
  const { data: rows } = await s
    .from('crm_email_accounts')
    .select('id, user_id, gmail_address, status, connected_at, last_used_at, last_polled_at, watch_expires_at')
    .order('connected_at', { ascending: false });

  const userIds = Array.from(new Set(((rows ?? []) as Array<{ user_id: string }>).map(r => r.user_id)));
  const profiles: Record<string, { firstName: string | null; lastName: string | null; email: string | null }> = {};
  if (userIds.length > 0) {
    const { data: ps } = await s
      .from('profiles')
      .select('id, first_name, last_name, email')
      .in('id', userIds);
    for (const p of (ps ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>) {
      profiles[p.id] = { firstName: p.first_name, lastName: p.last_name, email: p.email };
    }
  }

  const displayRows: AdminGmailAccountRow[] = ((rows ?? []) as Array<{
    id: string; user_id: string; gmail_address: string; status: string;
    connected_at: string; last_used_at: string | null;
    last_polled_at: string | null; watch_expires_at: string | null;
  }>).map(r => ({
    id:             r.id,
    userId:         r.user_id,
    userName:       [profiles[r.user_id]?.firstName, profiles[r.user_id]?.lastName].filter(Boolean).join(' ').trim() || null,
    userEmail:      profiles[r.user_id]?.email ?? null,
    gmailAddress:   r.gmail_address,
    status:         (r.status as AdminGmailAccountRow['status']),
    connectedAt:    r.connected_at,
    lastUsedAt:     r.last_used_at,
    lastPolledAt:   r.last_polled_at,
    watchExpiresAt: r.watch_expires_at,
  }));

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Gmail connections (admin)</h1>
        <p className="mt-1 text-sm text-gray-500">
          Every Gmail account connected to the CRM. Only admins see this page.
        </p>
      </div>
      <GmailAccountsAdminTable rows={displayRows} />
    </div>
  );
}
