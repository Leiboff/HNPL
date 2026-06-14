import { createClient as createServiceClient } from '@supabase/supabase-js';

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
  const { data: profile } = await svc
    .from('profiles')
    .select('id')
    .eq('email', normalized)
    .maybeSingle();
  if (profile?.id) {
    const { data: byId } = await svc.auth.admin.getUserById(profile.id);
    if (byId?.user) {
      return {
        id:                 byId.user.id,
        email_confirmed_at: byId.user.email_confirmed_at ?? null,
      };
    }
  }

  // Fallback: schema-scoped read against auth.users directly. Service-role
  // bypasses RLS on the auth schema, so this returns the row even when no
  // matching profile exists (the AUTH_ONLY orphan case).
  const authClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      db:   { schema: 'auth' },
    },
  );
  const { data: authUser } = await authClient
    .from('users')
    .select('id, email_confirmed_at')
    .eq('email', normalized)
    .maybeSingle();
  if (authUser) {
    return {
      id:                 authUser.id as string,
      email_confirmed_at: (authUser.email_confirmed_at as string | null) ?? null,
    };
  }

  return null;
}
