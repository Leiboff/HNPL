import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';

/**
 * Request-scoped `auth.getUser()` — one validation round trip per request,
 * however many callers ask for it.
 *
 * ─── WHY THIS EXISTS: THE LAYOUT PROBLEM ──────────────────────────────
 *
 * `app/patient/layout.tsx` and `app/provider/layout.tsx` are async area
 * gates. Each one starts with `requireConfirmedUser()`, which calls
 * `supabase.auth.getUser()`. Then the page inside renders and calls
 * `supabase.auth.getUser()` again for its own ownership filters.
 *
 * That second call is not cheap and it is not local. Every `getUser()` is
 * an unconditional `GET /auth/v1/user` against the auth server — the whole
 * point of it over `getSession()` is that it re-validates the JWT
 * server-side rather than trusting the cookie. auth-js does not memoise
 * it (see GoTrueClient._getUser), and the layout and the page hold
 * different client instances anyway, so an instance-level memo would not
 * have helped. The result: TWO identical validation round trips on every
 * page view in the two busiest areas of the app, for one answer that
 * cannot have changed in between.
 *
 * The layout's own chain — getUser, then the profile role read, then the
 * redirect — is genuinely serial and stays that way: each step needs the
 * previous step's result, and it is an authorisation gate, so it cannot be
 * deferred behind a Suspense boundary or moved into the page. What CAN be
 * removed is the page REPEATING it, which is what this file does.
 *
 * ─── WHAT IS DEDUPED, AND WHAT IS NOT ─────────────────────────────────
 *
 * Deduped: the network call that validates the token.
 *
 * NOT deduped: the authorisation DECISION. Every call site still does its
 * own `if (!user) redirect(...)`, its own `.eq('patient_id', user.id)`,
 * its own role check. Nothing is skipped and no gate is widened — each
 * caller asks the same question and acts on it exactly as before. The only
 * change is that the second asker is told the answer instead of
 * re-deriving it over the network.
 *
 * That substitution is sound because the window is a single request. The
 * access token arrives once, in the request's cookies, and cannot be
 * swapped mid-render; a token that validates at the start of the render
 * validates for its duration. Across requests there is no sharing at all —
 * `cache()` memoises per REQUEST, so a fresh request gets a fresh memo and
 * one user's identity can never be served to another.
 *
 * ─── WHY IT TAKES NO ARGUMENTS ────────────────────────────────────────
 *
 * `cache()` keys on argument identity. Passing the caller's Supabase
 * client in would give the layout and the page different keys, every
 * lookup would miss, and this file would be pure overhead — the same trap
 * documented in lib/patient/requestProfile.ts. A zero-argument function
 * has exactly one key, so it hits.
 *
 * The client is therefore created inside. Creating a second client is not
 * a round trip — it reads cookies and builds an object — so this costs
 * nothing measurable. Deliberately NOT done: memoising the client itself.
 * Sharing one client instance across a layout and a page would change
 * cookie-write and refresh behaviour for every caller in the tree, which
 * is a much wider behavioural change than this file is making, and it
 * would save no round trips at all.
 */
export const getRequestUser = cache(async () => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
});
