import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// ─── POST /api/auth/logout — server-side session revocation ────────────
//
// WHY A ROUTE AND NOT JUST A CLIENT CALL
//   Revocation is the one part of logging out that a client cannot be
//   trusted to complete: the browser is navigating away at the same
//   moment, and the call it would make is exactly the call that used to
//   hang and swallow the redirect (see lib/auth/logout.ts). Moving it here
//   means the request the client fires is same-origin and keepalive-able,
//   and the actual token invalidation happens on a server that is not
//   about to be torn down.
//
//   scope:'global' invalidates every refresh token for this user. That is
//   the point: without it, `local` logout merely discarded a browser copy
//   of a token that stayed valid upstream — so a token captured before
//   logout kept working, which is precisely the gap PCI DSS's
//   re-authentication requirement assumes is closed.
//
// COOKIES
//   createClient() binds to the request's cookie jar, and in a Route
//   Handler its setAll CAN write — so signOut's cookie clearing lands on
//   this response. The client clears locally as well; both happening is
//   intentional belt-and-braces, and the operations are idempotent.
//
// NOT AUTHENTICATED? Nothing to do — signOut with no session is a no-op
//   and this returns the same shape. Left deliberately open rather than
//   origin-checked: the only thing an unwanted caller achieves is logging
//   someone out, and a forced logout fails safe. Rejecting cross-origin
//   posts would also be the kind of check that quietly breaks on preview
//   deployments, trading a real reliability risk for a theoretical one.

export async function POST() {
  const supabase = await createClient();

  try {
    const { error } = await supabase.auth.signOut({ scope: 'global' });
    if (error) {
      // Reported, not thrown. The client does not read this response —
      // it cannot, it is already navigating — so the status exists purely
      // so a systematic failure is visible in logs and monitoring rather
      // than silently degrading every logout to local-only.
      console.error('[api/auth/logout] global signOut returned an error', error);
      return NextResponse.json({ revoked: false }, { status: 502 });
    }
  } catch (err) {
    console.error('[api/auth/logout] global signOut threw', err);
    return NextResponse.json({ revoked: false }, { status: 502 });
  }

  return NextResponse.json({ revoked: true });
}
