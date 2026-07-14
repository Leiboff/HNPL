import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { buildAuthUrl } from '@/lib/gmail/gmailClient';

// ─── /api/crm/gmail/connect — start the OAuth flow ────────────────────
//
// Sales/admin-only. Mints a state cookie (session_user_id + nonce) so
// the callback can verify the request came from the same session and
// bind the returned tokens to the right profile.

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'sales' && profile?.role !== 'admin') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  }

  const origin = new URL(req.url).origin;
  const redirectUri = `${origin}/api/crm/gmail/callback`;

  const nonce = crypto.randomBytes(16).toString('hex');
  const state = `${user.id}.${nonce}`;

  const url = buildAuthUrl({ state, redirectUri });
  const res = NextResponse.redirect(url);
  res.cookies.set('crm_gmail_state', state, {
    httpOnly: true,
    secure:   true,
    sameSite: 'lax',
    maxAge:   10 * 60,   // 10 min
    path:     '/',
  });
  return res;
}
