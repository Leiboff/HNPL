import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

// ─── requireConfirmedUser ────────────────────────────────────────────────────
//
// Defense-in-depth for every portal page. The single hard gate at the
// dashboard level — "Authentication → Providers → Email → Confirm email"
// — is the only thing currently preventing Supabase from minting a
// session for an unconfirmed user. If that toggle is ever flipped off, or
// a future code path re-introduces an auto-signin before verifyOtp, this
// helper still bounces unverified users to /verify-email instead of
// letting them silently reach a portal page.
//
// Usage at the top of any portal page:
//
//   import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
//
//   const { user, supabase } = await requireConfirmedUser();
//
// Behaviour:
//   • No session            → redirect('/login')
//   • Session + unconfirmed → redirect('/verify-email?email=…&next=<current path>')
//   • Session + confirmed   → returns { user, supabase }
//
// The `next` parameter on the verify-email redirect is best-effort — the
// helper doesn't know the page's pathname, so the caller can pass
// `next` explicitly when it matters. Default fallback is `/` so the user
// at least lands somewhere sensible after verifying.

import type { SupabaseClient } from '@supabase/supabase-js';

export type RequireConfirmedUserOptions = {
  /** Where to send the user after a successful verifyOtp. Defaults to '/'. */
  next?: string;
  /** If no session, where to send them. Defaults to '/login'. */
  unauthenticatedRedirect?: string;
};

export type RequireConfirmedUserResult = {
  // SupabaseClient generics are heavy; the helper only exposes the bits
  // callers reach for, so we keep it loosely typed at the boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>;
  user: {
    id:    string;
    email: string | null;
  };
};

export async function requireConfirmedUser(
  options: RequireConfirmedUserOptions = {},
): Promise<RequireConfirmedUserResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect(options.unauthenticatedRedirect ?? '/login');
  }

  // email_confirmed_at is null on auth.users until verifyOtp succeeds (or
  // until an admin manually flips it). Belt-and-braces against the
  // "Confirm email = OFF" dashboard regression.
  if (!user.email_confirmed_at) {
    const params = new URLSearchParams();
    if (user.email) params.set('email', user.email);
    params.set('next', options.next ?? '/');
    redirect(`/verify-email?${params.toString()}`);
  }

  return {
    supabase,
    user: { id: user.id, email: user.email ?? null },
  };
}
