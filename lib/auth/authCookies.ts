import type { NextResponse } from 'next/server';
import { isSupabaseAuthCookie } from './sessionCap';

// ─── Deleting the auth cookies on the response you are returning ───────
//
// The subtlety this exists for, written out once instead of three times:
//
// supabase.auth.signOut() clears the session by writing removal cookies
// through whatever cookie adapter its client was built with. That works —
// but only if signOut gets as far as removing the session, and only onto
// the response the adapter is bound to. Two ways that goes wrong:
//
//   • signOut REPORTS failure by RETURNING `{ error }`, not by throwing,
//     and it early-returns BEFORE removing the stored session when the
//     revocation call fails with anything other than 404/401/403 — a
//     network blip, a 5xx, a timeout. A caller that only wraps it in
//     try/catch sees nothing and carries on with the session intact.
//   • In middleware, signOut's writes land on the response the session
//     refresher built. A branch that returns a DIFFERENT response (a
//     redirect) discards them.
//
// Either way the visitor keeps a live session while being shown a screen
// that says they do not have one. So on any path whose whole purpose is
// to END a session, the deletion is done HERE, explicitly, on the
// response being returned — and signOut's success becomes a bonus rather
// than the mechanism.
//
// Callers: the session-cap branch in proxy.ts, the terms refusal in
// app/auth/callback/route.ts, and app/auth/require-terms/route.ts.

/**
 * Delete every Supabase auth cookie named in `names` from `response`.
 *
 * Pass the names from the REQUEST (and, in middleware, from the mutated
 * request too). Chunk counts change when a session crosses the 4 KB
 * cookie limit, so the set of names actually present is not knowable from
 * one source — and a partially deleted chunked cookie is worse than
 * either extreme, because @supabase/ssr reassembles whatever it finds.
 */
export function clearAuthCookies(response: NextResponse, names: Iterable<string>): void {
  for (const name of new Set(names)) {
    if (isSupabaseAuthCookie(name)) response.cookies.delete(name);
  }
}
