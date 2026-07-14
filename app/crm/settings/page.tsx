import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import GmailConnectionCard from './GmailConnectionCard';

// ─── /crm/settings — per-user CRM setup ───────────────────────────────
//
// Currently limited to Gmail connection status. Sales/admin only.

export const dynamic = 'force-dynamic';

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export default async function CrmSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const { user, supabase } = await requireConfirmedUser({ next: '/crm/settings' });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'sales' && profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  // Service-role read — the table is deny-all to session clients.
  const { data: account } = await svc()
    .from('crm_email_accounts')
    .select('gmail_address, status, connected_at')
    .eq('user_id', user.id)
    .maybeSingle();

  const params = await searchParams;

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Per-user CRM setup. Gmail is the only integration in Phase 2.
        </p>
      </div>

      <GmailConnectionCard
        account={account ? {
          gmailAddress: account.gmail_address as string,
          status:       account.status as 'connected' | 'reauth_required' | 'revoked',
          connectedAt:  account.connected_at as string,
        } : null}
        connectedFlag={params.connected ?? null}
        errorFlag={params.error ?? null}
      />
    </div>
  );
}
