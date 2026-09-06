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
import { readReferralParam } from '@/lib/referrals/link';
import { REFERRAL_COOKIE, referralCookieOptions } from '@/lib/referrals/attribution';
import { claimReferral } from '@/lib/referrals/claim';
import { supabaseReferralStore } from '@/lib/referrals/store';

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
  const isApiRoute = request.nextUrl.pathname === '/api'
    || request.nextUrl.pathname.startsWith('/api/');
  // Some API-prefixed handlers (notably OAuth connect/callback routes) are
  // browser-facing endpoints reached through links or provider redirects.
  // Fetch Metadata is the strongest signal that the browser is loading a
  // document; Accept is a fallback for clients that do not send Sec-Fetch-Mode.
  const acceptsHtml = request.headers.get('accept')
    ?.split(',')
    .some((value) => value.trim().split(';', 1)[0] === 'text/html') ?? false;
  const fetchMode = request.headers.get('sec-fetch-mode');
  const isDocumentNavigation = fetchMode === 'navigate'
    || (fetchMode === null
      && (request.method === 'GET' || request.method === 'HEAD')
      && acceptsHtml);

  // A fresh unpredictable nonce per HTML request is the prerequisite for a
  // strict CSP. Next reads this request header while rendering and applies
  // the nonce to its framework scripts automatically. API requests still run
  // through the authentication/session-cap logic below, but do not need HTML
  // CSP headers or a nonce.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', request.nextUrl.pathname);
  const nonce = isApiRoute
    ? null
    : Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = nonce
    ? createCsp(nonce, process.env.NODE_ENV === 'development')
    : null;
  if (nonce && csp) {
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', csp);
  }

  // Save reference so we can read its cookies after updateSession may refresh them.
  const modifiedRequest = new NextRequest(request, { headers: requestHeaders });
  const { response, user, supabase } = await updateSession(modifiedRequest);
  response.headers.set('x-pathname', request.nextUrl.pathname);
  if (csp) response.headers.set('Content-Security-Policy', csp);

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

    let capped: NextResponse;
    if (isApiRoute && !isDocumentNavigation) {
      // A fetch follows redirects without navigating the document. Returning
      // the login page here would therefore turn an expired API session into
      // HTML (or a 405 for POSTs), which callers may mistake for a transient
      // network or JSON-decoding failure. Give every API method an explicit,
      // machine-readable authentication failure instead. API-prefixed routes
      // loaded as browser documents still use the redirect below so OAuth
      // links and callbacks can carry the user back to the login screen.
      capped = NextResponse.json(
        { error: 'unauthenticated', reason: SESSION_CAP_REDIRECT_REASON },
        { status: 401 },
      );
    } else {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      loginUrl.search = '';
      loginUrl.searchParams.set('reason', SESSION_CAP_REDIRECT_REASON);
      capped = NextResponse.redirect(loginUrl);
    }
    if (csp) capped.headers.set('Content-Security-Policy', csp);

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

  // ── Referral capture ─────────────────────────────────────────────────────
  //
  // A referred visitor arrives at `/?ref=A2C4K9PT` from a WhatsApp message,
  // reads the landing page, and signs up — maybe now, maybe in a fortnight,
  // across an email OTP and four onboarding steps. The code is in the URL at
  // the first of those and nowhere near any of the others, so it moves into a
  // cookie here. Same mechanism, same posture and the same place as the
  // invitation claim above; see lib/referrals/attribution.ts for each flag.
  //
  // Only on a document navigation: a `?ref=` on a fetch or an image request
  // is not somebody arriving, and setting a cookie from one would let any
  // page on the internet write this cookie with a chosen code by embedding
  // `<img src="https://app…/?ref=THEIRCODE">`.
  //
  // FIRST CODE WINS. The cookie is not overwritten while one is present,
  // which is the same rule the write-once attribution index enforces in the
  // database (0145) — a second link cannot take the first referrer's credit,
  // and the two layers agree rather than one quietly undoing the other.
  const referralParam = isDocumentNavigation
    ? readReferralParam(request.nextUrl.searchParams)
    : null;
  const heldReferral = request.cookies.get(REFERRAL_COOKIE)?.value ?? null;
  if (referralParam && !heldReferral) {
    response.cookies.set(
      REFERRAL_COOKIE,
      referralParam,
      referralCookieOptions(process.env.NODE_ENV === 'production'),
    );
  }

  // ── Referral claim ───────────────────────────────────────────────────────
  //
  // Spent on the first authenticated request that sees the cookie. `user`
  // comes from updateSession above rather than a second auth.getUser() — that
  // call is a network round trip against the auth server, and the invitation
  // block's own client predates the value being returned.
  //
  // Every refusal is terminal and drops the cookie; only a database or
  // network failure is retried, which is why claimReferral reports
  // `terminal` separately from the outcome. See lib/referrals/claim.ts for
  // the five refusals and why each one is a refusal.
  //
  // A code captured on THIS request is claimable on it: an already-signed-in
  // patient who taps a friend's link should not need a second navigation for
  // it to count. The `delete` below then simply undoes the `set` above.
  const referralCookie = heldReferral ?? referralParam;
  if (referralCookie && user) {
    try {
      const svc = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { cookies: { getAll() { return []; }, setAll() {} } },
      );
      const { data: claimant, error: claimantError } = await svc
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();
      if (claimantError) throw claimantError;

      if (!claimant) {
        // NO PROFILE ROW YET — not "not a patient".
        //
        // This is the one case claimReferral explicitly reports as
        // `transient` rather than terminal (see the `findAccount` branch in
        // lib/referrals/claim.ts): the on_auth_user_created trigger has not
        // run, or the OAuth callback is still provisioning the row
        // defensively. Folding it into the role refusal below made that
        // recovery unreachable — the cookie was deleted here, before
        // claimReferral ever saw the request — and a referral lost this way
        // is lost for good, because the `?ref=` is no longer in the URL.
        //
        // So: leave the cookie. The next authenticated request finds the row.
        console.warn('[referrals] claim deferred — no profile row yet', {
          profileId: user.id,
        });
      } else if (claimant.role !== 'patient') {
        // Patient referral attribution is not meaningful for any other
        // profile type. Spend the cookie without consuming the database's
        // write-once attribution slot.
        console.info('[referrals] claim refused — claimant is not a patient', {
          profileId: user.id, role: claimant.role,
        });
        response.cookies.delete(REFERRAL_COOKIE);
      } else {
        const claim = await claimReferral(supabaseReferralStore(svc), {
          profileId:   user.id,
          cookieValue: referralCookie,
        });
        // The outcome was previously discarded, which made a referral that
        // did not land completely undiagnosable: five different refusals all
        // present to an operator as "nothing happened", and the cookie is
        // gone by the time anybody asks why. One line per claim is cheap —
        // this block runs at most once per account, because every outcome
        // except `transient` is terminal.
        if (claim.outcome === 'attributed') {
          console.info('[referrals] attributed', {
            profileId: user.id, referralId: claim.referralId,
          });
        } else {
          console.warn('[referrals] not attributed', {
            profileId: user.id, outcome: claim.outcome, code: referralCookie,
          });
        }
        if (claim.terminal) response.cookies.delete(REFERRAL_COOKIE);
      }
    } catch (err) {
      // Belt to claimReferral's own braces: it already converts a failure into
      // a non-terminal outcome, so reaching here means something outside it
      // threw — the role read above, or a missing service-role key. Leave the
      // cookie; the next request tries again. Logged rather than swallowed,
      // because a claim that throws on EVERY request retries for thirty days
      // and reports nothing at all.
      console.error('[referrals] claim threw outside claimReferral', err);
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
    // API requests always pass through authentication/session-cap handling.
    // Keep this separate from the document matcher so a client cannot bypass
    // those checks by attaching one of Next's prefetch headers.
    '/api/:path*',
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
