import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { revokeGmailAccount } from '@/lib/gmail/gmailClient';

// ─── /api/crm/gmail/disconnect — revoke + delete the connection ──────

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'sales' && profile?.role !== 'admin') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  }

  const res = await revokeGmailAccount(user.id);
  if (res.error) return NextResponse.json({ error: res.error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
