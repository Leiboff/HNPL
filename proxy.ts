import { NextRequest } from 'next/server';
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

  return response;
}

export const config = {
  matcher: [
    // Excludes static assets + the PWA surfaces (manifest + SW +
    // generated icons). The SW route in particular must never have
    // auth cookies attached to the response — the browser scopes
    // SW registrations to origin, and a Set-Cookie on the SW body
    // bytes could nudge a confused cache state.
    '/((?!_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|sw\\.js|icon-\\d+\\.png|icon-maskable\\.png|apple-icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
