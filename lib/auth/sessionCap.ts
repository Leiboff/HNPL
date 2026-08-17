/**
 * Absolute session lifetime cap — the layer we had none of.
 *
 * ─── WHY A CAP AT ALL ─────────────────────────────────────────────────
 *
 * Before this, a session could live forever. Nothing in the app or the
 * schema bounded it, and the two mechanisms that look like they might
 * don't:
 *
 *   • The idle guard measures LAST ACTIVITY, so any interaction resets
 *     it. Touch the page once every quarter of an hour and the session
 *     never ends.
 *   • The access token expiring hourly is irrelevant, because
 *     lib/supabase/middleware.ts calls `auth.getUser()` on every request,
 *     which silently redeems the refresh token and mints a new one.
 *
 * ─── WHY IT MATTERS SO MUCH HERE: THE COOKIE ──────────────────────────
 *
 * This is the reasoning that justifies the cap, so it lives next to the
 * code that enforces it.
 *
 * The auth cookie is written by @supabase/ssr using its
 * DEFAULT_COOKIE_OPTIONS, which we do not override anywhere:
 *
 *     { path: '/', sameSite: 'lax', httpOnly: false, maxAge: 400 days }
 *
 * Two consequences, both by @supabase/ssr's design rather than by any
 * mistake of ours — the browser client has to be able to read the session
 * from JavaScript, so httpOnly is not available to us:
 *
 *   1. `maxAge: 400 days` — the cookie is PERSISTENT, not browser-
 *      session. Closing the browser does not clear it. Combined with an
 *      unexpiring refresh token, "how long am I still signed in after
 *      closing the browser?" answered: over a year.
 *
 *   2. `httpOnly: false` — the session cookie is readable by any
 *      JavaScript running on the page. So an XSS does not merely steal a
 *      one-hour access token; it steals a REFRESH token that, uncapped,
 *      is good for the full 400 days. The attacker needs to land their
 *      payload once and keeps a working session for a year.
 *
 * The cap is what turns that year into hours. It is the reason this
 * module exists, and the reason it is enforced server-side (proxy.ts)
 * rather than in the client — a control that answers to the browser is no
 * answer to a compromised browser.
 *
 * ─── WHAT THIS CHECK DOES NOT BIND ────────────────────────────────────
 *
 * Recorded here because it is easy to over-read what the paragraph above
 * promises, and because the answer changes which layer you should trust.
 *
 * The proxy check only sees traffic that comes THROUGH OUR APP. Somebody
 * holding a stolen refresh token is not obliged to use our app at all:
 * they can POST it straight to Supabase's own token endpoint
 * (`/auth/v1/token?grant_type=refresh_token`) and get fresh access tokens
 * back, then use those directly against the PostgREST and Storage APIs.
 * Nothing in proxy.ts is on that path, so nothing in this file stops it.
 *
 * The same argument disposes of the idle timeout even more completely: it
 * is client-side JavaScript, so it gives ZERO protection against a stolen
 * token. An attacker does not run our app, does not mount our
 * InactivityGuard, and never reads the localStorage timestamp.
 *
 * So the honest ordering of the layers is:
 *
 *   • THE SUPABASE DASHBOARD TIMEBOX IS LOAD-BEARING. It is enforced at
 *     the token endpoint itself, which is the one place every path —
 *     ours, curl, a script — has to go through. It is the only thing that
 *     actually bounds a stolen refresh token.
 *
 *   • THIS FILE IS DEFENCE IN DEPTH. It bounds the ordinary cases, which
 *     are the common ones: an unattended logged-in browser, a shared
 *     reception machine, a lost laptop being used as a laptop. It is
 *     pinned by tests and visible in review, which the dashboard value is
 *     not. It is not a substitute for the dashboard setting and must not
 *     be treated as one.
 *
 * That ordering is a correction to how this was originally scoped —
 * code-first was approved on the understanding that the two layers were
 * closer to equivalent than they are. They are not.
 *
 * ─── WHY `last_sign_in_at` ────────────────────────────────────────────
 *
 * The cap must be measured from AUTHENTICATION, not from last activity —
 * otherwise it is just a second idle timeout. Supabase sets
 * `user.last_sign_in_at` when credentials are actually presented and does
 * NOT touch it on a token refresh, which makes it the correct anchor and,
 * being server-supplied, one the browser cannot forge.
 *
 * ─── WHY IN CODE AS WELL AS IN THE DASHBOARD ──────────────────────────
 *
 * Given the ordering above, the dashboard timebox is the one that must be
 * set. This exists in addition to it because a dashboard value is
 * invisible to the repo, untestable in CI, and can be changed or reverted
 * by anyone with project access without leaving a trace in a diff —
 * whereas this is pinned by tests and reviewed like any other code. Two
 * independent layers, neither redundant: one covers paths that never
 * touch our app, the other cannot be silently switched off.
 */

/**
 * Two hours from sign-in.
 *
 * WHY SO SHORT — the reasoning that decided it
 *   The instinct is to size this against the working day, and that is the
 *   wrong axis. The idle timeout is client-side JavaScript, so it offers
 *   NO protection against a stolen token: an attacker does not run our
 *   app and never meets InactivityGuard. Which means this cap is the only
 *   thing standing between a captured refresh token and its 400-day
 *   cookie lifetime — and against that threat the difference between two
 *   hours and twelve is the difference between a short window and a
 *   working day of free access.
 *
 *   So the length is set by how long a stolen token stays useful, not by
 *   how long a shift is.
 *
 * WHY NOT ONE HOUR
 *   One hour is defensible and was considered. Two is preferred for one
 *   concrete reason: practice and provider onboarding are long, form-heavy
 *   flows, and being bounced to /login mid-setup is the one genuinely
 *   avoidable annoyance here. Two hours clears those without materially
 *   widening the window.
 *
 * WHAT IT COSTS
 *   Staff re-authenticate a few times a day rather than once. That is the
 *   intended trade and it is a small one — note this is a cap on the
 *   SESSION, not an idle timeout, so nobody is interrupted for being
 *   away from the keyboard; they are asked to sign in again for having
 *   been signed in a long time.
 */
export const ABSOLUTE_SESSION_MAX_MS = 2 * 60 * 60 * 1000;

/** Where a capped session lands. The login page reads `reason`. */
export const SESSION_CAP_REDIRECT_REASON = 'session_expired';

/**
 * Has this session outlived the cap?
 *
 * FAILS CLOSED on a missing or unparseable timestamp. That direction is
 * cheap and self-healing: the worst case is one unnecessary sign-in,
 * after which `last_sign_in_at` is freshly populated and correct. Failing
 * open would silently restore the uncapped behaviour this module exists
 * to remove — and would do it invisibly, which is worse than a visible
 * annoyance.
 *
 * A timestamp in the future (clock skew between Supabase and the edge)
 * needs no special case: the subtraction goes negative, which is below
 * any cap, so a skewed clock never forces a spurious sign-out.
 */
export function sessionExceedsAbsoluteCap(
  lastSignInAt: string | null | undefined,
  nowMs: number,
  capMs: number = ABSOLUTE_SESSION_MAX_MS,
): boolean {
  if (!lastSignInAt) return true;
  const authenticatedAtMs = Date.parse(lastSignInAt);
  if (!Number.isFinite(authenticatedAtMs)) return true;
  return nowMs - authenticatedAtMs >= capMs;
}

/**
 * Paths the cap must never fire on.
 *
 * These are the routes by which a session is OBTAINED. Capping them can
 * only produce a redirect loop — and specifically it would do so in the
 * one situation where we most need the user to be able to recover: if
 * clearing the auth cookies ever fails (a domain mismatch, a partially
 * rolled-out deploy), an unexempted /login would bounce forever and the
 * user could not sign in again to fix it.
 *
 * Note what is NOT here: /update-password. A password reset link creates
 * a fresh sign-in, so its `last_sign_in_at` is new and the cap does not
 * bite; and a genuinely 12-hour-old session being sent to log in before
 * it can change a password is correct, not a bug.
 */
export function isCapExemptPath(pathname: string): boolean {
  return (
    pathname === '/login'
    || pathname.startsWith('/login/')
    || pathname === '/signup'
    || pathname.startsWith('/signup/')
    || pathname === '/forgot-password'
    || pathname.startsWith('/auth/')
    || pathname.startsWith('/api/auth/')
  );
}

/**
 * Is this one of Supabase's auth cookies?
 *
 * Matched by prefix rather than by exact name because the name embeds the
 * project ref (`sb-<ref>-auth-token`) and is CHUNKED when the session
 * exceeds the 4 KB cookie limit (`…-auth-token.0`, `.1`, …). Deleting
 * only the unsuffixed name would leave the chunks behind, and a partially
 * deleted chunked cookie is worse than either extreme: @supabase/ssr
 * reassembles what it finds. `sb-` is Supabase's own reserved prefix and
 * nothing else in this app sets a cookie with it, so the broad match is
 * safe as well as correct.
 */
export function isSupabaseAuthCookie(name: string): boolean {
  return name.startsWith('sb-');
}
