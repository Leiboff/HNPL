'use server';

// Rate limiting note: a simple in-memory Map would work in a single-process
// dev server but is unreliable in production (multiple serverless instances each
// have their own memory). We rely on Supabase's built-in auth rate limits for
// now; a Redis/Upstash-backed limiter can be added in a later hardening pass.

import { createClient } from '@supabase/supabase-js';
import { isValidEmail } from '@/lib/validation';
import { consumeAll, clientIp, RATE_LIMITS } from '@/lib/security/rateLimit';

export async function resendConfirmation(_email: string): Promise<{ ok: true }> {
  try {
    const email = _email.trim().toLowerCase();

    // Invalid format → neutral response, no DB hit.
    if (!isValidEmail(email)) return { ok: true };

    // ── Rate limit (audit F-17) ────────────────────────────────────────
    //
    // The note at the top of this file said we were relying on Supabase's
    // built-in auth limits "for now"; this is the later hardening pass it
    // promised. Keyed per-IP AND per target address, because the two abuse
    // shapes are different: one IP enumerating many addresses, and many
    // IPs mail-bombing one inbox. Only the second is a limit on the
    // ADDRESS, and it is the one that reaches a real person.
    //
    // A refusal returns the SAME neutral { ok: true } as everything else
    // in this function. Saying "rate limited" here would leak that the
    // address exists — the whole point of the shape of this action.
    const allowed = await consumeAll('resend_confirmation', [
      [await clientIp(), RATE_LIMITS.resend_confirmation.ip],
      [email,                         RATE_LIMITS.resend_confirmation.account!],
    ]);
    if (!allowed) return { ok: true };

    const svc = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    // Step 1 — check whether a profile exists for this email.
    // Service-role bypasses RLS; we only touch our own public.profiles table.
    const { data: profile } = await svc
      .from('profiles')
      // ilike, not eq. profiles.email is written by the 0024 trigger from
      // whatever auth.users holds, so an address typed 'Test@x.com' is
      // stored with that casing and an eq against the lower-cased form
      // silently finds nothing — the same bug lib/auth/findExistingAuthUser
      // documents and fixed for itself. Here it meant a legitimate resend
      // request for a mixed-case address quietly did nothing at all.
      // Addresses have no wildcards to escape and the value is already
      // trimmed and lower-cased.
      .select('id')
      .ilike('email', email)
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
