import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// ─── Auth callback — PKCE code exchange for Supabase recovery / email links ─
//
// Used by the password-reset flow (new in this build) and any other
// magic-link / email-confirmation flow that lands the browser back on
// our origin with a `?code=…` query param. The Supabase auth server
// verifies the token, redirects here, and we exchange the code for a
// session (setting the auth cookies via the SSR client).
//
// Contract:
//   • Success → 302 to `?next=<path>` (default '/'). The `next` param
//     must be an origin-relative path — we never redirect off-domain.
//   • Missing/invalid code → 302 to /forgot-password?error=expired,
//     which shows the friendly "link expired / invalid" state.
//   • Unknown Supabase error → same friendly error page.

const DEFAULT_NEXT = '/dashboard';

function safeNext(raw: string | null): string {
  if (!raw) return DEFAULT_NEXT;
  // Must be same-origin: allow only leading-slash relative paths, no
  // protocol-relative or absolute URLs that could redirect off-domain.
  if (!raw.startsWith('/') || raw.startsWith('//')) return DEFAULT_NEXT;
  return raw;
}

export async function GET(request: NextRequest) {
  const url    = new URL(request.url);
  const code   = url.searchParams.get('code');
  const next   = safeNext(url.searchParams.get('next'));
  const origin = url.origin;

  if (!code) {
    // Nothing to exchange — treat as an expired / bad link. The
    // /forgot-password page's `?error=expired` state offers a
    // Request-new-link path.
    return NextResponse.redirect(`${origin}/forgot-password?error=expired`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // Recovery codes are single-use + time-limited. A repeat click on
    // the same link, or a click after the token TTL, lands here.
    return NextResponse.redirect(`${origin}/forgot-password?error=expired`);
  }

  // Session is now attached to the response cookies. Redirect to the
  // per-flow destination (update-password for a reset; /dashboard for
  // a login-link; etc.).
  return NextResponse.redirect(`${origin}${next}`);
}
