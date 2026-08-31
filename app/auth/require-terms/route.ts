import { NextResponse, type NextRequest } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { clearAuthCookies } from '@/lib/auth/authCookies';
import { hasAcceptedTerms } from '@/lib/legal/acceptance';

// ─── GET /auth/require-terms — the refusal, where cookies can be written
//
// The redirect target of lib/legal/termsGate.ts. A Server Component
// cannot clear cookies (setting them during render is unsupported — see
// the cookies() API docs, and the swallowed write in
// lib/supabase/server.ts), so a page-level gate cannot end a session by
// itself. It sends the visitor here, and this Route Handler does the part
// that needs a response to write onto.
//
// What it does, in order:
//
//   1. Re-verifies the condition SERVER-SIDE. This is why the route is
//      safe to be a GET that logs you out: it refuses to sign out an
//      account that HAS accepted, so it cannot be used as a drive-by
//      logout link for a normal user. A visitor who does not need
//      refusing is simply sent on their way.
//   2. Revokes globally, so the refresh token is dead upstream and not
//      merely unreachable from this browser.
//   3. Deletes the auth cookies on the response it returns, rather than
//      trusting signOut's own cookie writes — signOut reports failure by
//      RETURNING an error and skips removing the session when it does.
//      That exact gap is what let a refused OAuth arrival keep its
//      session and walk into an onboarding step. See
//      lib/auth/authCookies.ts.
//   4. Sends them to /signup with the same ?error=terms the callback
//      uses, so both refusal paths land on one screen and one message.
//
// The profile row is read with the SERVICE client, not the session one.
// The read must not depend on RLS policies evaluated against a session we
// are in the middle of destroying, and "we could not read the row" has to
// resolve to "refuse" rather than to "probably fine".

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

function refuse(request: NextRequest, response: NextResponse): NextResponse {
  clearAuthCookies(response, request.cookies.getAll().map((c) => c.name));
  return response;
}

export async function GET(request: NextRequest) {
  const origin = new URL(request.url).origin;
  const supabase = await createClient();

  let userId: string | null = null;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch (err) {
    // Cannot establish who this is. Clear and send them to the front
    // door: there is no version of this route that lets an unverifiable
    // session continue.
    console.error('[auth/require-terms] getUser failed', err);
    return refuse(request, NextResponse.redirect(`${origin}/signup?error=terms`));
  }

  // No session at all — nothing to refuse, and nothing to clear. They are
  // already in the state this route exists to produce.
  if (!userId) {
    return NextResponse.redirect(`${origin}/signup?error=terms`);
  }

  let accepted = false;
  try {
    const { data: profile, error } = await svc()
      .from('profiles')
      .select('terms_accepted_at, onboarding_completed')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    accepted = hasAcceptedTerms(profile);
  } catch (err) {
    // Fail CLOSED. An unreadable row is the one case where guessing
    // "accepted" would undo the whole gate.
    console.error('[auth/require-terms] profile read failed — refusing', err);
    accepted = false;
  }

  // Already accepted: this visitor does not belong here. Do NOT sign them
  // out — send them to the dispatcher. This branch is what makes a GET
  // logout route harmless.
  if (accepted) {
    return NextResponse.redirect(`${origin}/dashboard`);
  }

  try {
    // Reported, not thrown, when it fails — hence the returned-error
    // check as well as the catch. Either way the cookie deletion below
    // is what actually stops this browser.
    const { error } = await supabase.auth.signOut({ scope: 'global' });
    if (error) {
      console.error('[auth/require-terms] global signOut returned an error', error);
    }
  } catch (err) {
    console.error('[auth/require-terms] global signOut threw', err);
  }

  return refuse(request, NextResponse.redirect(`${origin}/signup?error=terms`));
}
