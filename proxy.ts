import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { updateSession } from '@/lib/supabase/middleware';

export async function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', request.nextUrl.pathname);

  // Save reference so we can read its cookies after updateSession may refresh them.
  const modifiedRequest = new NextRequest(request, { headers: requestHeaders });
  const response = await updateSession(modifiedRequest);
  response.headers.set('x-pathname', request.nextUrl.pathname);

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

  // ── Patient verification gate ─────────────────────────────────────────────
  // Runs on every request (including RSC navigations) so the gate holds on
  // client-side navigation, not just hard loads.
  const path = request.nextUrl.pathname;
  if (path.startsWith('/patient') && path !== '/patient/verify-identity') {
    // Use modifiedRequest.cookies — updateSession's setAll mutates these in
    // memory, so they reflect any token refresh that just happened.
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return modifiedRequest.cookies.getAll(); },
          setAll() {},  // read-only context; refresh already handled above
        },
      },
    );

    const { data: { user } } = await supabase.auth.getUser();

    // No user → let the layout's existing /login redirect handle it.
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('sa_id_verified')
        .eq('id', user.id)
        .single();

      // Fail closed: anything other than exactly true → redirect.
      if (profile?.sa_id_verified !== true) {
        return NextResponse.redirect(
          new URL('/patient/verify-identity', request.url),
        );
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
