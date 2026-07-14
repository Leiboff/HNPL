import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { revokeGmailAccount } from '@/lib/gmail/gmailClient';

// ─── /api/crm/gmail/disconnect — revoke + delete a connection ────────
//
// Body: { accountId?: string; gmailAddress?: string }
// If neither is supplied, disconnects ALL of the user's Gmail accounts.
// Sales/admin only; RLS on the table is deny-all so the service-role
// wrapper in revokeGmailAccount is the sole write path.

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'sales' && profile?.role !== 'admin') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  }

  let body: { accountId?: unknown; gmailAddress?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body — remove all */ }

  const accountId    = typeof body.accountId    === 'string' ? body.accountId    : undefined;
  const gmailAddress = typeof body.gmailAddress === 'string' ? body.gmailAddress : undefined;

  const res = await revokeGmailAccount(user.id, { accountId, gmailAddress });
  return NextResponse.json({ ok: true, removed: res.removed });
}
