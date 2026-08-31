import { NextResponse, type NextRequest } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { TERMS_VERSION } from '@/lib/legal/terms';
import { PRIVACY_VERSION } from '@/lib/legal/privacy';
import { clearAuthCookies } from '@/lib/auth/authCookies';
import { hasAcceptedTerms } from '@/lib/legal/acceptance';

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
//
// ─── Acceptance is a PRECONDITION of the session, not a later step ────
//
// The /signup chooser puts an unticked box under BOTH its options and
// will not start either route without it, then sends `terms_accepted=1`
// on the OAuth round trip. That parameter is what this route records.
//
// It is deliberately NOT inferred. An earlier version stamped every
// OAuth arrival on the strength of a "by continuing…" line, which made
// the record say more than the visitor had actually done.
//
// There used to be an onboarding step (app/onboarding/terms/) as a
// backstop for arrivals with nothing recorded. It is gone, and the
// enforcement moved HERE, because a backstop downstream of a live
// session is not enforcement: it is a screen an unverified account can
// sit in front of. The rule now is absolute —
//
//   an OAuth arrival with no acceptance ON THE PROFILE ROW does not get
//   to keep its session.
//
// If the tick is missing, or the stamp fails to write for any reason,
// the session is signed out and the visitor is returned to /signup to
// agree. The account row Supabase created during the exchange survives
// (deleting an auth user on a sign-IN path would be catastrophic if we
// misjudged who it was), but it is inert: every subsequent arrival
// meets the same gate until an acceptance is actually recorded.
//
// ─── How that refusal LEAKED, and what it took to close it ────────────
//
// The refusal used to be `try { await signOut() } catch {}` and then a
// redirect. That is not a refusal. supabase.auth.signOut() reports a
// failed revocation by RETURNING `{ error }`, and it early-returns
// BEFORE removing the stored session when the revocation call fails with
// anything other than 404/401/403 — a network blip, a 5xx, a timeout. A
// try/catch sees none of that, so the visitor was shown
// /signup?error=terms while still holding a live session; the
// client-side "already signed in?" shortcut on that very page then sent
// them to /dashboard, and the patient layout forwarded them into an
// onboarding step. Reported from the field, and exactly the sequence a
// tester hits: sign in with Google, get bounced to accept the terms, try
// again, land in onboarding.
//
// So the refusal no longer depends on signOut succeeding. The auth
// cookies are DELETED on the response this handler returns
// (lib/auth/authCookies.ts), signOut's returned error is read rather
// than ignored, and the same rule is enforced again downstream by
// lib/legal/termsGate.ts on every surface a session can reach. The
// callback is no longer the only thing standing between "no acceptance"
// and "in the app", because a single choke point on a security rule is
// one bug away from no rule at all.
//
// WHAT THIS RECORD IS WORTH, stated plainly. The tick happens before any
// session exists — there is no profile to stamp at that moment — so the
// acceptance has to travel as a query parameter, and a query parameter
// is client-asserted. Only the person completing the OAuth flow can set
// it, so the failure mode is someone asserting their own agreement
// rather than someone forging another's; but it is weaker than a server
// action on an authenticated session.
//
// ONE EXCEPTION, and it is not a hole: an account whose
// onboarding_completed is already true is let through with a NULL
// column. Those are accounts that finished onboarding before any of
// this existed. Locking existing customers out of an app they already
// use, over a record we never asked them for, would be a worse wrong
// than the gap it closes — and onboarding_completed is written only by
// the server, never by anything the visitor controls.

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

/**
 * Outcome of the OAuth profile fixup.
 *
 *   'ok'           → profile is synced AND an acceptance is on record.
 *   'needs-terms'  → no acceptance recorded and none offered. Refuse.
 *   'write-failed' → an acceptance was offered but did not land. Refuse.
 *
 * The last two are distinguished only so the visitor gets an accurate
 * sentence; both refuse the session.
 */
type OAuthSyncOutcome = 'ok' | 'needs-terms' | 'write-failed';

function consentColumns(): Record<string, unknown> {
  return {
    terms_accepted_at: new Date().toISOString(),
    terms_version:     TERMS_VERSION,
    privacy_version:   PRIVACY_VERSION,
  };
}

async function ensureOAuthProfileSynced(
  userId: string,
  email: string,
  metadata: Record<string, unknown> | null | undefined,
  consentGiven: boolean,
): Promise<OAuthSyncOutcome> {
  const client = svc();

  // Read the existing profile row (created by the on_auth_user_created
  // trigger). If none exists — which shouldn't happen given the trigger
  // is DEFINER-mode — insert it here.
  const { data: profile, error: readErr } = await client
    .from('profiles')
    .select('id, first_name, last_name, role, terms_accepted_at, onboarding_completed')
    .eq('id', userId)
    .maybeSingle();

  // Couldn't even read the row, so we cannot know whether an acceptance
  // exists. Fail closed: assuming "probably fine" is exactly the
  // best-effort posture this gate replaced.
  if (readErr) {
    console.error('[auth/callback] profile read failed — refusing session', { userId, message: readErr.message });
    return 'write-failed';
  }

  const names = extractOAuthName(metadata);

  if (!profile) {
    // Belt-and-braces: trigger didn't fire OR the row was deleted.
    // Provision as a standard patient (role='patient') — but only WITH
    // the acceptance. There is no such thing here as an existing
    // customer to protect: if we are inserting the row, this arrival is
    // creating the account, so no tick means no account.
    if (!consentGiven) return 'needs-terms';

    console.warn('[auth/callback] profile row missing after OAuth session — provisioning defensively', { userId });
    const { error: insertErr } = await client.from('profiles').insert({
      id:         userId,
      email,
      role:       'patient',
      first_name: names.first || '',
      last_name:  names.last  || '',
      verification_status: 'unverified',
      ...consentColumns(),
    });
    if (insertErr) {
      console.error('[auth/callback] defensive profile insert failed — refusing session', { userId, message: insertErr.message });
      return 'write-failed';
    }
    return 'ok';
  }

  // Existing profile — never overwrite the role (guards against a
  // Google sign-in for a staff email accidentally converting them).
  // Only fill in name fields if they're currently empty. This is the
  // Google-metadata-to-profile-row bridge — a one-shot fill-in that's
  // idempotent thereafter.
  const updates: Record<string, unknown> = {};
  if (!profile.first_name && names.first) updates.first_name = names.first;
  if (!profile.last_name  && names.last)  updates.last_name  = names.last;

  // Write-once: an existing acceptance is an audit fact and is never
  // re-versioned by a later sign-in. The rule itself (including the
  // grandfather clause for accounts that finished onboarding before any
  // of this existed) lives in lib/legal/acceptance.ts, because three
  // other surfaces now ask the same question and none of them may
  // answer it differently.
  const needsAcceptance = !hasAcceptedTerms(profile);

  if (needsAcceptance && !consentGiven) return 'needs-terms';

  // Kept in its own object so the name-sync payload above stays
  // names-only, never role.
  const consent: Record<string, unknown> = needsAcceptance ? consentColumns() : {};

  if (Object.keys(updates).length === 0 && Object.keys(consent).length === 0) {
    return 'ok';
  }

  // .select() back, not just an error check. An update that matches no
  // rows is not an error in PostgREST — it is a silent no-op, which is
  // precisely the "the write didn't happen" case this gate exists to
  // catch.
  const { data: written, error: writeErr } = await client
    .from('profiles')
    .update({ ...updates, ...consent })
    .eq('id', userId)
    .select('terms_accepted_at');

  if (!needsAcceptance) {
    // Names-only sync. A failure here costs an empty display name, not
    // a legal record — never a reason to refuse a session.
    if (writeErr) console.warn('[auth/callback] name sync failed (non-blocking):', writeErr.message);
    return 'ok';
  }

  if (writeErr || !written?.length || !written[0].terms_accepted_at) {
    console.error('[auth/callback] terms acceptance did not land — refusing session', {
      userId,
      message: writeErr?.message ?? 'update matched no rows',
    });
    return 'write-failed';
  }

  return 'ok';
}

export async function GET(request: NextRequest) {
  const url    = new URL(request.url);
  const code   = url.searchParams.get('code');
  const next   = safeNext(url.searchParams.get('next'));
  // Set by ContinueWithGoogleButton only when its caller collected the
  // tick. Strict equality — any other value is treated as absent.
  const consentGiven = url.searchParams.get('terms_accepted') === '1';
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
  // dispatcher redirect, run the OAuth profile-sync fixup — a one-shot
  // name fill-in for first-time Google users, and the acceptance gate.
  //
  // Password-reset and magic-link users have no OAuth identity and skip
  // the whole thing: they already have an account, and this route is
  // not where a password reset gets re-litigated.
  let user = null;
  try {
    ({ data: { user } } = await supabase.auth.getUser());
  } catch (err) {
    console.error('[auth/callback] getUser failed after exchange', err);
    return NextResponse.redirect(`${origin}/forgot-password?error=expired`);
  }

  const identities       = user?.identities ?? [];
  const hasOAuthIdentity = identities.some((i) => i.provider !== 'email');
  if (!user || !hasOAuthIdentity) {
    return NextResponse.redirect(`${origin}${next}`);
  }

  let outcome: OAuthSyncOutcome;
  try {
    outcome = await ensureOAuthProfileSynced(
      user.id,
      user.email ?? '',
      user.user_metadata as Record<string, unknown> | null | undefined,
      consentGiven,
    );
  } catch (err) {
    // Fail CLOSED. This used to swallow the error and redirect anyway,
    // on the reasoning that a name-sync failure shouldn't cost the user
    // their session. The same code path now decides whether an
    // acceptance exists, and "we don't know" has to mean "no".
    console.error('[auth/callback] OAuth profile sync threw — refusing session', err);
    outcome = 'write-failed';
  }

  if (outcome !== 'ok') {
    // No acceptance on record → no session. Revoke globally so the
    // refresh token is dead upstream, THEN delete the auth cookies on the
    // response we are actually returning — see the note above for why
    // signOut alone was not enough, and lib/auth/authCookies.ts for the
    // mechanics. Order matters: revoke while the token still exists.
    try {
      const { error: signOutError } = await supabase.auth.signOut({ scope: 'global' });
      if (signOutError) {
        // Reported, not thrown, by design in supabase-js. Logged so a
        // systematic revocation failure is visible — but never load-
        // bearing, because the deletion below is what stops this browser.
        console.error('[auth/callback] signOut after refused session returned an error', signOutError);
      }
    } catch (err) {
      console.error('[auth/callback] signOut after refused session threw', err);
    }

    const refused = NextResponse.redirect(
      `${origin}/signup?error=${outcome === 'write-failed' ? 'terms_write' : 'terms'}`,
    );
    clearAuthCookies(refused, request.cookies.getAll().map((c) => c.name));
    return refused;
  }

  return NextResponse.redirect(`${origin}${next}`);
}
