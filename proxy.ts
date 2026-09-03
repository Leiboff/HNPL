import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { updateSession } from '@/lib/supabase/middleware';
import {
  SESSION_CAP_REDIRECT_REASON,
  isCapExemptPath,
  sessionExceedsAbsoluteCap,
} from '@/lib/auth/sessionCap';
import { clearAuthCookies } from '@/lib/auth/authCookies';
import {
  issueConsentToken,
  TERMS_CONSENT_COOKIE,
} from '@/lib/legal/consentToken';
import { createCsp } from '@/lib/security/csp';

// ─── Where the legal acceptance token is minted (audit A-14) ───────────────
//
// The surfaces that RENDER the acceptance control and link to both documents.
// Requesting one of these pages is the event the token attests to, which is
// why it is minted here rather than by a Server Action the client calls: a
// cookie set on the way to rendering /signup means "this browser was served
// the page that displays the terms", and that is not something a caller can
// assert for itself.
//
// /login is included because ContinueWithGoogleButton lives there too and
// carries the same consent note. An existing customer who has already
// accepted does not need the token — the callback only consults it when an
// acceptance is MISSING — but a first-time Google user who arrives via
// /login rather than /signup would otherwise be bounced for something the
// page did in fact show them.
const CONSENT_TOKEN_PATHS = new Set([
  '/signup',
  '/signup/patient',
  '/login',
]);

export async function proxy(request: NextRequest) {
  // A fresh unpredictable nonce per HTML request is the prerequisite for a
  // strict CSP. Next reads this request header while rendering and applies
  // the nonce to its framework scripts automatically.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = createCsp(nonce, process.env.NODE_ENV === 'development');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', request.nextUrl.pathname);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  // Save reference so we can read its cookies after updateSession may refresh them.
  const modifiedRequest = new NextRequest(request, { headers: requestHeaders });
  const { response, user, supabase } = await updateSession(modifiedRequest);
  response.headers.set('x-pathname', request.nextUrl.pathname);
  response.headers.set('Content-Security-Policy', csp);

  // ── Absolute session cap ─────────────────────────────────────────────
  // Enforced HERE, on the server, and not in the client: the whole value
  // of a cap measured from authentication is that a compromised or
  // cooperative browser cannot move it. The idle guard is the client-side
  // layer and can be defeated by clearing localStorage; this one cannot be
  // defeated from the browser at all, which is why it is the layer that
  // bounds the 400-day, JS-readable auth cookie @supabase/ssr issues (the
  // reasoning is written out in lib/auth/sessionCap.ts).
  //
  // Runs before the invitation claim below so an over-cap session cannot
  // perform a write on its way out.
  if (
    user
    && !isCapExemptPath(request.nextUrl.pathname)
    && sessionExceedsAbsoluteCap(user.last_sign_in_at, Date.now())
  ) {
    // Revoke server-side first, so the refresh token is dead and not
    // merely unreachable. Best-effort: if it fails we still clear the
    // cookies below, which is what stops this browser.
    try {
      await supabase.auth.signOut({ scope: 'global' });
    } catch (err) {
      console.error('[proxy] session-cap revocation failed', err);
    }

    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    loginUrl.searchParams.set('reason', SESSION_CAP_REDIRECT_REASON);

    const capped = NextResponse.redirect(loginUrl);
    capped.headers.set('Content-Security-Policy', csp);

    // Delete on the RESPONSE we are actually returning: signOut's own
    // cookie writes landed on `response`, which this branch discards.
    // (It also skips them outright when its revocation call fails — see
    // lib/auth/authCookies.ts, which is now the one implementation of
    // this deletion, shared with the two terms-refusal routes.)
    //
    // Names are collected from BOTH the original request and the mutated
    // one. updateSession's setAll writes refreshed cookies onto
    // modifiedRequest, and a refresh can change the CHUNK COUNT (a session
    // crossing the 4 KB limit splits into `…-auth-token.0`, `.1`). So the
    // original request may not name every cookie now present, and a
    // partially deleted chunked cookie is worse than either extreme —
    // @supabase/ssr reassembles whatever it finds.
    clearAuthCookies(capped, [
      ...request.cookies.getAll().map((c) => c.name),
      ...modifiedRequest.cookies.getAll().map((c) => c.name),
    ]);
    return capped;
  }

  // ── Invitation claim ─────────────────────────────────────────────────────
  // On the patient's first authenticated request after signup-via-invite,
  // link their pending plan and mark the invitation accepted.
  const inviteToken = request.cookies.get('hnpl_invite_token')?.value;
  if (inviteToken) {
    const authClient = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return modifiedRequest.cookies.getAll(); },
          setAll() {},
        },
      },
    );

    const { data: { user: claimUser } } = await authClient.auth.getUser();

    // If not yet authenticated, leave the cookie for the next request.
    if (claimUser) {
      try {
        const svc = createServerClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { cookies: { getAll() { return []; }, setAll() {} } },
        );

        const { data: invite } = await svc
          .from('patient_invitations')
          .select('id, plan_id, email')
          .eq('token', inviteToken)
          .is('accepted_at', null)
          .maybeSingle();

        if (!invite) {
          // Terminal: token not found or invitation already accepted.
          response.cookies.delete('hnpl_invite_token');
        } else if (invite.email.toLowerCase() !== (claimUser.email ?? '').toLowerCase()) {
          // Terminal: this token was created for a different email address.
          // Do not link — clear the cookie so it isn't retried.
          response.cookies.delete('hnpl_invite_token');
        } else {
          // Attempt to link. .select('id') returns the updated row only if the
          // update ran (i.e. patient_id was still null). Zero rows = already linked.
          const { data: linked } = await svc
            .from('plans')
            .update({ patient_id: claimUser.id })
            .eq('id', invite.plan_id)
            .is('patient_id', null)
            .select('id');

          if (Array.isArray(linked) && linked.length > 0) {
            // Plan was just linked — now safe to mark the invitation accepted.
            await svc
              .from('patient_invitations')
              .update({ accepted_at: new Date().toISOString() })
              .eq('id', invite.id);
          }

          // Terminal: plan was linked now, or was already linked by a prior
          // attempt. Either way there is nothing left to claim.
          response.cookies.delete('hnpl_invite_token');
        }
      } catch {
        // Transient DB/network error — leave the cookie so the claim retries
        // on the next request.
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── Mint the legal-acceptance token (audit A-14) ──────────────────────
  //
  // Was: /auth/callback trusted `?terms_accepted=1` off the query string, so
  // the acceptance record attested to a parameter the visitor controlled
  // rather than to anything the platform had shown them. Under the NCA and
  // POPIA §11 that is the difference between a consent record and a note.
  //
  // Re-minted on every request to these paths, deliberately: the token is
  // cheap, its 30-minute life starts when the documents were last put in
  // front of the visitor, and a reload should restart that clock rather than
  // inherit a nearly-expired one.
  //
  // httpOnly so no script can read or forge it; SameSite=Lax so it survives
  // the top-level GET navigation back from Google while staying off
  // cross-site POSTs.
  if (CONSENT_TOKEN_PATHS.has(request.nextUrl.pathname)) {
    const { token, maxAgeSeconds } = issueConsentToken();
    response.cookies.set(TERMS_CONSENT_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure:   process.env.NODE_ENV === 'production',
      path:     '/',
      maxAge:   maxAgeSeconds,
    });
  }

  return response;
}

export const config = {
  matcher: [
    // Excludes static assets + the PWA surfaces (manifest + SW +
    // generated icons). The SW route in particular must never have
    // auth cookies attached to the response — the browser scopes
    // SW registrations to origin, and a Set-Cookie on the SW body
    // bytes could nudge a confused cache state.
    {
      source: '/((?!api|_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|sw\\.js|icon-\\d+\\.png|icon-maskable\\.png|apple-icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
