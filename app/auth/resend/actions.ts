'use server';

// Rate limiting note: a simple in-memory Map would work in a single-process
// dev server but is unreliable in production (multiple serverless instances each
// have their own memory). We rely on Supabase's built-in auth rate limits for
// now; a Redis/Upstash-backed limiter can be added in a later hardening pass.

import { createClient } from '@supabase/supabase-js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function resendConfirmation(_email: string): Promise<{ ok: true }> {
  try {
    const email = _email.trim().toLowerCase();

    // Invalid format → neutral response, no DB hit.
    if (!EMAIL_RE.test(email)) return { ok: true };

    const svc = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    // Step 1 — check whether a profile exists for this email.
    // Service-role bypasses RLS; we only touch our own public.profiles table.
    const { data: profile } = await svc
      .from('profiles')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    // No profile → no account → send nothing.
    if (!profile) return { ok: true };

    // Step 2 — check email_confirmed_at via the admin API (auth.users row).
    // getUserById is the only admin method that accepts a user ID and returns
    // the full User object including email_confirmed_at.
    const { data: { user } } = await svc.auth.admin.getUserById(profile.id);

    // Already confirmed → send nothing.
    if (!user || user.email_confirmed_at) return { ok: true };

    // Step 3 — unconfirmed account exists: trigger the resend.
    // supabase.auth.resend() (GoTrueClient) accepts a service-role api key;
    // GoTrue's /resend endpoint looks up the user by email and re-sends the OTP.
    await svc.auth.resend({ type: 'signup', email });
  } catch {
    // Swallow every error — never leak internal state to the caller.
  }

  // Always the same neutral response regardless of what happened above.
  return { ok: true };
}
