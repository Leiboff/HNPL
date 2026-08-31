// ─── Is SUPABASE_SERVICE_ROLE_KEY actually a service-role key? ──────────
//
// This exists because of a bug that was impossible to see from the app's
// behaviour, and cost two rounds of guessing.
//
// The symptom: email signup returned "We couldn't record your agreement to
// the terms, so your account wasn't created" for every address, forever.
//
// The mechanism: a client built with a key that is NOT service-role does
// not fail loudly against `profiles`. It fails SILENTLY, because of how
// this schema's RLS is shaped:
//
//   • SELECT — `users_select_own_profile` is `id = auth.uid()`. With no
//     session on that client, auth.uid() is null, so the read returns
//     ZERO ROWS. Not an error. Zero rows.
//   • UPDATE — `users_update_own_profile`, same predicate, same result:
//     zero rows affected, no error. PostgREST calls that a success.
//   • INSERT — migration 0030 dropped the client-facing insert policy
//     entirely, on the correct reasoning that the handle_new_user trigger
//     creates profiles and "service-role inserts bypass RLS and are
//     unaffected". So an insert is the ONE operation that refuses out
//     loud, with 42501.
//
// Put together: every read says "no such row", every update says "nothing
// to do", and only a write attempt admits anything is wrong. Which reads
// exactly like "the profile row is missing" — and sent two rounds of
// investigation after the trigger, the signup action, and the acceptance
// stamp, none of which were broken.
//
// So the key gets checked, by name, and the answer goes in the log.
//
// ─── Why decoding an unverified JWT is fine here ───────────────────────
//
// This is OUR OWN environment variable, not a token from a request. We are
// not authenticating anybody with it; we are asking "which of our keys did
// someone paste into this variable". A signature check would answer a
// question nobody asked, and would need Supabase's secret to perform.
// Nothing here is a security decision — it is a configuration diagnosis.
//
// Nothing in this file logs, returns, or otherwise reveals any part of the
// key itself.

export type ServiceKeyKind =
  /** Not set at all. */
  | 'missing'
  /** A legacy JWT whose role claim is service_role. Correct. */
  | 'service_role'
  /** A new-format secret key (sb_secret_…). Also correct. */
  | 'secret'
  /** A legacy JWT whose role claim is anon. WRONG — this is the browser key. */
  | 'anon'
  /** A new-format publishable key (sb_publishable_…). WRONG — browser key. */
  | 'publishable'
  /** Present, but not a shape we recognise. */
  | 'unknown';

/** Decode a JWT payload without verifying it. Null if it isn't one. */
function jwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  try {
    // base64url → base64, then decode. Buffer tolerates missing padding.
    const json = Buffer.from(segments[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function classifyServiceKey(key: string | null | undefined): ServiceKeyKind {
  if (typeof key !== 'string' || key.trim() === '') return 'missing';
  const trimmed = key.trim();

  if (trimmed.startsWith('sb_secret_'))      return 'secret';
  if (trimmed.startsWith('sb_publishable_')) return 'publishable';

  const payload = jwtPayload(trimmed);
  const role = payload?.role;
  if (role === 'service_role') return 'service_role';
  if (role === 'anon')         return 'anon';

  return 'unknown';
}

/** The two kinds that can actually write past RLS. */
export function isUsableServiceKey(kind: ServiceKeyKind): boolean {
  return kind === 'service_role' || kind === 'secret';
}

/**
 * A sentence naming the misconfiguration, or null when the key is fine.
 *
 * Written for whoever is reading the log at 2am, which is why it says what
 * to change rather than merely what is wrong.
 */
export function serviceKeyProblem(kind: ServiceKeyKind): string | null {
  switch (kind) {
    case 'service_role':
    case 'secret':
      return null;
    case 'missing':
      return 'SUPABASE_SERVICE_ROLE_KEY is not set in this environment. '
        + 'Every privileged read returns zero rows and every privileged insert is refused by RLS.';
    case 'anon':
      return 'SUPABASE_SERVICE_ROLE_KEY holds an ANON key (role="anon" in its JWT claims) — the browser key, '
        + 'not the service key. It cannot bypass RLS: reads on profiles return zero rows and inserts are '
        + 'refused with 42501. Copy the service_role / secret key from Supabase → Project Settings → API.';
    case 'publishable':
      return 'SUPABASE_SERVICE_ROLE_KEY holds a PUBLISHABLE key (sb_publishable_…) — the browser key, not the '
        + 'secret one. Use the sb_secret_… key from Supabase → Project Settings → API.';
    case 'unknown':
      return 'SUPABASE_SERVICE_ROLE_KEY is set but is neither a service_role JWT nor an sb_secret_… key. '
        + 'It may be truncated, from another project, or a legacy key that has been disabled.';
  }
}

/**
 * Classify what this process is actually holding. Reads the env var itself
 * so callers cannot accidentally pass the anon key in and get a clean bill.
 */
export function currentServiceKeyKind(): ServiceKeyKind {
  return classifyServiceKey(process.env.SUPABASE_SERVICE_ROLE_KEY);
}
