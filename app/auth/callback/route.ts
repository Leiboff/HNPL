import { NextResponse, type NextRequest } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

// ─── Auth callback — PKCE code exchange for recovery / OAuth / magic links
//
// Used by:
//   • Password-reset flow (Supabase recovery link)
//   • Google OAuth (signInWithOAuth('google') from patient surfaces)
//   • Any future magic-link / email-confirmation flow
//
// All PKCE-based Supabase auth flows land here with `?code=…` — the
// server-side exchange sets the auth cookies via the SSR client, then
// we redirect to `?next=…` (default /dashboard, the role dispatcher).
//
// Contract:
//   • Success → 302 to `?next=<path>` (default /dashboard). `next` MUST
//     be an origin-relative path; the safeNext sanitiser blocks any
//     absolute or protocol-relative URL.
//   • Missing/invalid code → 302 to /forgot-password?error=expired
//     (which shows the friendly "link expired / invalid" state and is
//     the recovery landing for a stale reset link).
//   • Unknown Supabase error → same friendly error page.
//
// OAuth-specific: after the exchange we run ensureOAuthProfileSynced()
// as a belt-and-braces provisioner:
//   • The DB trigger [0024] auto-creates a profile row on
//     auth.users insert, defaulting role='patient' when no role
//     appears in raw_user_meta_data — which is exactly what Google
//     signups look like.
//   • The trigger reads first_name / last_name from raw_user_meta_data,
//     but Google populates given_name / family_name (its own OAuth
//     claim names). To keep Google patients' profiles populated
//     without a migration, we sync the display name from
//     user.user_metadata on first arrival if the profile row's name
//     fields are empty.
//   • If (edge case) the trigger somehow didn't fire, we insert the
//     profile ourselves so the caller never lands in the app
//     half-provisioned.

const DEFAULT_NEXT = '/dashboard';

function safeNext(raw: string | null): string {
  if (!raw) return DEFAULT_NEXT;
  // Must be same-origin: allow only leading-slash relative paths, no
  // protocol-relative or absolute URLs that could redirect off-domain.
  if (!raw.startsWith('/') || raw.startsWith('//')) return DEFAULT_NEXT;
  return raw;
}

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

// Pull the best available display-name fields out of an OAuth user's
// metadata. Google emits `given_name` / `family_name` / `full_name` /
// `name`; other providers emit `first_name` / `last_name`. We accept
// any of them.
function extractOAuthName(metadata: Record<string, unknown> | null | undefined): { first: string; last: string } {
  const md = metadata ?? {};
  const given  = (md.given_name  as string | undefined) ?? (md.first_name as string | undefined) ?? '';
  const family = (md.family_name as string | undefined) ?? (md.last_name  as string | undefined) ?? '';
  if (given || family) return { first: given.trim(), last: family.trim() };

  // Fallback: split a "full_name" / "name" on the first space.
  const full = (md.full_name as string | undefined) ?? (md.name as string | undefined) ?? '';
  if (full) {
    const trimmed = full.trim();
    const spaceAt = trimmed.indexOf(' ');
    if (spaceAt === -1) return { first: trimmed, last: '' };
    return { first: trimmed.slice(0, spaceAt), last: trimmed.slice(spaceAt + 1) };
  }
  return { first: '', last: '' };
}

async function ensureOAuthProfileSynced(userId: string, email: string, metadata: Record<string, unknown> | null | undefined): Promise<void> {
  const client = svc();

  // Read the existing profile row (created by the on_auth_user_created
  // trigger). If none exists — which shouldn't happen given the trigger
  // is DEFINER-mode — insert it here.
  const { data: profile } = await client
    .from('profiles')
    .select('id, first_name, last_name, role')
    .eq('id', userId)
    .maybeSingle();

  const names = extractOAuthName(metadata);

  if (!profile) {
    // Belt-and-braces: trigger didn't fire OR the row was deleted.
    // Provision as a standard patient (role='patient').
    console.warn('[auth/callback] profile row missing after OAuth session — provisioning defensively', { userId });
    await client.from('profiles').insert({
      id:         userId,
      email,
      role:       'patient',
      first_name: names.first || '',
      last_name:  names.last  || '',
      verification_status: 'unverified',
    });
    return;
  }

  // Existing profile — never overwrite the role (guards against a
  // Google sign-in for a staff email accidentally converting them).
  // Only fill in name fields if they're currently empty. This is the
  // Google-metadata-to-profile-row bridge — a one-shot fill-in that's
  // idempotent thereafter.
  const updates: Record<string, unknown> = {};
  if (!profile.first_name && names.first) updates.first_name = names.first;
  if (!profile.last_name  && names.last)  updates.last_name  = names.last;
  if (Object.keys(updates).length === 0) return;

  await client.from('profiles').update(updates).eq('id', userId);
}

export async function GET(request: NextRequest) {
  const url    = new URL(request.url);
  const code   = url.searchParams.get('code');
  const next   = safeNext(url.searchParams.get('next'));
  const origin = url.origin;

  if (!code) {
    return NextResponse.redirect(`${origin}/forgot-password?error=expired`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/forgot-password?error=expired`);
  }

  // Session is now attached to the response cookies. Before the
  // dispatcher redirect, run the OAuth profile-sync fixup — a no-op
  // for password-reset users (their profile is already populated) and
  // a one-shot name fill-in for first-time Google users.
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const identities = user?.identities ?? [];
    const hasOAuthIdentity = identities.some((i) => i.provider !== 'email');
    if (user && hasOAuthIdentity) {
      await ensureOAuthProfileSynced(user.id, user.email ?? '', user.user_metadata as Record<string, unknown> | null | undefined);
    }
  } catch (err) {
    // Never block the redirect on a fixup failure. The user still
    // reaches /dashboard with a valid session; their profile may just
    // have empty name fields, which is recoverable via /patient
    // settings.
    console.error('[auth/callback] OAuth profile sync failed (non-blocking)', err);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
