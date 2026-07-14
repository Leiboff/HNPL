import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { exchangeCodeForTokens, fetchGmailProfile, saveGmailAccount } from '@/lib/gmail/gmailClient';

// ─── /api/crm/gmail/callback — OAuth landing ─────────────────────────
//
// Validates the state cookie matches ?state=, exchanges the code for
// tokens (offline access → refresh_token issued), persists the
// encrypted refresh token, redirects back to /crm/settings.

export const dynamic = 'force-dynamic';

function backToSettings(origin: string, msg: string, ok: boolean): Response {
  const url = new URL('/crm/settings', origin);
  url.searchParams.set(ok ? 'connected' : 'error', msg);
  return NextResponse.redirect(url);
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

  // The state format is <userId>.<nonce>. Ensure the userId matches the session.
  const stateUserId = stateParam.split('.')[0];
  if (stateUserId !== user.id) return backToSettings(origin, 'user_mismatch', false);

  const redirectUri = `${origin}/api/crm/gmail/callback`;
  try {
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    if (!tokens.refresh_token) {
      // Happens if the account previously granted consent and Google
      // didn't reissue a refresh_token. Ask the user to revoke access
      // in their Google account first — we forced prompt=consent so
      // this should be rare.
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

    const res = backToSettings(origin, profile.emailAddress, true);
    res.headers.append('Set-Cookie', 'crm_gmail_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    return res;
  } catch (caught) {
    const msg = caught instanceof Error ? caught.message.slice(0, 60) : 'exchange_failed';
    return backToSettings(origin, msg, false);
  }
}
