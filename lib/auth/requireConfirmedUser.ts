import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getRequestUser } from './requestUser';

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
    id:                 string;
    email:              string | null;
    /** Non-null because the helper redirects unconfirmed users. */
    email_confirmed_at: string;
    /**
     * Providers on this auth user, extracted from user.identities.
     * 'email' for email/password, 'google' for Google OAuth, etc.
     * The onboarding step list keys off this to decide whether the
     * verify-email step is part of the user's PATH.
     */
    identity_providers: readonly string[];
  };
};

export async function requireConfirmedUser(
  options: RequireConfirmedUserOptions = {},
): Promise<RequireConfirmedUserResult> {
  const supabase = await createClient();

  // Request-scoped: the async area layouts (/patient, /provider) call this,
  // and the page inside then asks for the user again. That used to be two
  // `GET /auth/v1/user` round trips for one answer. The GATE below is
  // unchanged and still runs on every call — only the validation round trip
  // is shared. See lib/auth/requestUser.ts.
  //
  // Deliberately NOT wrapping this whole function in cache(): `options`
  // differs per caller (the `next` path), so it would key on a fresh object
  // every time and never hit — and a memoised `redirect()` throw is not
  // something to introduce on an auth path.
  const user = await getRequestUser();

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

  // Identities → provider string list. Supabase types `identities` as
  // `UserIdentity[] | undefined`; each entry has a required `provider`
  // string. We freeze the array so downstream consumers can't mutate it.
  const identityProviders: readonly string[] = Object.freeze(
    (user.identities ?? []).map((i) => i.provider),
  );

  return {
    supabase,
    user: {
      id:                 user.id,
      email:              user.email ?? null,
      email_confirmed_at: user.email_confirmed_at,
      identity_providers: identityProviders,
    },
  };
}
