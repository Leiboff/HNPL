// ─── findExistingAuthUser ────────────────────────────────────────────────────
//
// Looks up a Supabase auth user by email — covering BOTH normal lookups and
// the AUTH_ONLY orphan case.
//
// Background. Two ways for an auth.users row to exist for a given email:
//   (1) Normal: signUp() succeeded, the on_auth_user_created trigger
//       (migration 0033) wrote a public.profiles row, and the practice
//       (or patient) row was inserted. Both tables have a record.
//   (2) AUTH_ONLY orphan: a prior signUp succeeded, the trigger wrote
//       the profile row, but a downstream INSERT failed and the rollback
//       could not delete the auth user (the profiles.id → auth.users(id)
//       FK has no ON DELETE CASCADE, so auth.admin.deleteUser errors out).
//       The retry path then deleted the profile manually but left the
//       auth user. The profile is gone but the auth user lingers.
//
// Why a profile-only lookup isn't enough. The previous Q2 abandon-recovery
// check looked up the public.profiles row by email. It catches case (1) —
// the normal abandon-at-OTP scenario where the profile exists. It does NOT
// catch case (2), because there is no profile to find. Without this fallback,
// the next signUp() returns Supabase's anti-enumeration silent response
// (data.user = null, error = null), the caller misreads it as "shouldn't
// happen", and the user can never sign up again with that email.
//
// What we return. The auth user's id and email_confirmed_at, or null if no
// such user exists. Caller decides what to do (resend OTP if unconfirmed,
// "sign in instead" if confirmed).

export type ExistingAuthUser = {
  id:                  string;
  email_confirmed_at:  string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

export async function findExistingAuthUser(
  svc: Svc,
  email: string,
): Promise<ExistingAuthUser | null> {
  const normalized = email.trim().toLowerCase();

  // Cheap path: profile by email → admin.getUserById.
  // Catches normal abandon-at-OTP cases without paying for a schema-
  // scoped query against auth.users.
  //
  // ilike, not eq. profiles.email is written by the 0024 trigger from
  // whatever auth.users holds, and an address typed as "Test@gmail.com"
  // is stored with that casing — so an `eq` against the lower-cased form
  // silently misses it and reports "no existing user" for an email that
  // very much exists. Addresses have no wildcards to escape, and the
  // caller has already trimmed and lower-cased.
  const { data: profile, error: profileErr } = await svc
    .from('profiles')
    .select('id')
    .ilike('email', normalized)
    .maybeSingle();
  if (profileErr) {
    // Not fatal — the fallback below may still find them — but never
    // silent: a failing lookup here reports "no such user" to a caller
    // that is about to create a duplicate account.
    console.error('[findExistingAuthUser] profile lookup failed', profileErr.message);
  }
  if (profile?.id) {
    const { data: byId } = await svc.auth.admin.getUserById(profile.id);
    if (byId?.user) {
      return {
        id:                 byId.user.id,
        email_confirmed_at: byId.user.email_confirmed_at ?? null,
      };
    }
  }

  // Fallback: the AUTH_ONLY orphan — an auth user whose profile row is
  // gone, so the lookup above has nothing to find.
  //
  // ─── THIS USED TO BE UNABLE TO WORK ──────────────────────────────────
  //
  // It built a PostgREST client with `db: { schema: 'auth' }` and queried
  // auth.users. PostgREST only serves schemas in its `db-schemas` setting,
  // and a Supabase project ships with `public, graphql_public` — NOT
  // `auth`. So the query returned PGRST106 ("The schema must be one of the
  // following…"), the error was discarded, and "no row" was
  // indistinguishable from "no user". The fallback was inert from the day
  // it was written.
  //
  // The consequence is the one this file's header predicted: signUp
  // returns the anti-enumeration silent response (data.user = null,
  // error = null) and the visitor can never sign up with that address
  // again. It reached production, twice, as "We couldn't record your
  // agreement to the terms" — a message about the acceptance stamp, for a
  // failure that was neither about acceptance nor about the stamp.
  //
  // Now it goes through find_auth_user_by_email (migration 0119): a
  // SECURITY DEFINER function in `public`, EXECUTE granted to service_role
  // alone. No schema exposure, one indexed lookup, and an error that is
  // an error rather than an absence.
  const { data: rpcRows, error: rpcErr } = await svc
    .rpc('find_auth_user_by_email', { p_email: normalized });

  if (rpcErr) {
    // Loudly. A failure here is the difference between "recover this
    // half-finished signup" and "this address can never be used again".
    console.error('[findExistingAuthUser] find_auth_user_by_email failed', rpcErr.message);
    return null;
  }

  const found = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  if (found?.id) {
    return {
      id:                 found.id as string,
      email_confirmed_at: (found.email_confirmed_at as string | null) ?? null,
    };
  }

  return null;
}
