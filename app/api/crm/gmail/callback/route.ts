import { NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import {
  exchangeCodeForTokens,
  fetchGmailProfile,
  saveGmailAccount,
  startGmailWatch,
} from '@/lib/gmail/gmailClient';

// ─── /api/crm/gmail/callback — OAuth landing ─────────────────────────
//
// Since 0072 we start a Pub/Sub watch (best-effort) on every fresh
// connect when GMAIL_PUBSUB_TOPIC is set. Without the env var we skip
// the watch and the system stays on the daily safety-net poller —
// preserves pre-Pub/Sub behaviour so the deploy is safe before ops
// wires up the topic.

export const dynamic = 'force-dynamic';

function backToSettings(origin: string, msg: string, ok: boolean): Response {
  const url = new URL('/crm/settings', origin);
  url.searchParams.set(ok ? 'connected' : 'error', msg);
  return NextResponse.redirect(url);
}

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function GET(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return backToSettings(origin, 'unauthenticated', false);

  const url        = new URL(req.url);
  const stateParam = url.searchParams.get('state') ?? '';
  const code       = url.searchParams.get('code');
  const err        = url.searchParams.get('error');

  const cookieHeader = req.headers.get('cookie') ?? '';
  const cookieState  = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith('crm_gmail_state='))?.slice('crm_gmail_state='.length);

  if (!cookieState || cookieState !== stateParam) {
    return backToSettings(origin, 'state_mismatch', false);
  }
  if (err) return backToSettings(origin, err, false);
  if (!code) return backToSettings(origin, 'missing_code', false);

  const stateUserId = stateParam.split('.')[0];
  if (stateUserId !== user.id) return backToSettings(origin, 'user_mismatch', false);

  const redirectUri = `${origin}/api/crm/gmail/callback`;
  try {
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    if (!tokens.refresh_token) {
      return backToSettings(origin, 'no_refresh_token', false);
    }
    const profile = await fetchGmailProfile(tokens.access_token);
    const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000);
    const saveRes = await saveGmailAccount({
      userId:       user.id,
      gmailAddress: profile.emailAddress,
      refreshToken: tokens.refresh_token,
      accessToken:  tokens.access_token,
      expiresAt,
    });
    if (saveRes.error) return backToSettings(origin, 'save_failed', false);

    // Best-effort Pub/Sub watch. If the topic env var is unset the
    // system stays polling — nothing to configure, nothing breaks.
    const topic = process.env.GMAIL_PUBSUB_TOPIC;
    if (topic && saveRes.accountId) {
      try {
        const w = await startGmailWatch(tokens.access_token, topic);
        const expiration = w.expiration ? new Date(Number(w.expiration)).toISOString() : null;
        const s = svc();
        await s.from('crm_email_accounts').update({
          last_history_id:  w.historyId,
          watch_expires_at: expiration,
        }).eq('id', saveRes.accountId);
        await s.from('crm_audit_log').insert({
          actor_id:    user.id,
          action:      'gmail_account.watch_started',
          target_type: 'crm_email_account',
          target_id:   saveRes.accountId,
          details:     { gmail_address: profile.emailAddress, expiration },
        });
      } catch (watchErr) {
        console.warn('[gmail-callback] watch start failed', watchErr);
      }
    }

    const res = backToSettings(origin, profile.emailAddress, true);
    res.headers.append('Set-Cookie', 'crm_gmail_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    return res;
  } catch (caught) {
    const msg = caught instanceof Error ? caught.message.slice(0, 60) : 'exchange_failed';
    return backToSettings(origin, msg, false);
  }
}
