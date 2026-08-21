// ─── Last sign-in method — a purely local UX hint ───────────────────────
//
// Highlights whichever of Google / passkey / email+password a visitor used
// last time on THIS BROWSER — the same "last used" affordance most consumer
// apps put on their login screen. Lives entirely in localStorage: no
// account column, no server round trip, and nothing here is ever read
// server-side or trusted for anything beyond which option gets a highlight.
// A cleared browser or a new device simply shows no highlight, which is
// the expected, honest behaviour — not a bug to fix with a server fallback.
//
// Google is the one method recorded on ATTEMPT rather than confirmed
// success: signInWithOAuth navigates the whole page away to Google, so
// there is no client-side "it worked" callback to hook — see
// ContinueWithGoogleButton's onSignInAttempt. Passkey and password both
// record on confirmed success, since both complete in-page.

export type LastSignInMethod = 'password' | 'google' | 'passkey';

const METHOD_KEY = 'bn_last_signin_method';
const EMAIL_KEY  = 'bn_last_signin_email';

function isLastSignInMethod(v: string | null): v is LastSignInMethod {
  return v === 'password' || v === 'google' || v === 'passkey';
}

/**
 * Record the method that just (or is about to, for Google — see header)
 * succeed. Swallows every storage error — private browsing, disabled
 * storage, quota — because this is a cosmetic hint, never load-bearing.
 */
export function setLastSignInMethod(method: LastSignInMethod, email?: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(METHOD_KEY, method);
    if (method === 'password' && email) {
      window.localStorage.setItem(EMAIL_KEY, email);
    } else if (method !== 'password') {
      // A later Google/passkey sign-in shouldn't leave a stale address
      // behind to prefill next time password is the highlighted method.
      window.localStorage.removeItem(EMAIL_KEY);
    }
  } catch {
    // Ignored — see header.
  }
}

export function getLastSignInMethod(): { method: LastSignInMethod | null; email: string | null } {
  if (typeof window === 'undefined') return { method: null, email: null };
  try {
    const method = window.localStorage.getItem(METHOD_KEY);
    if (!isLastSignInMethod(method)) return { method: null, email: null };
    return { method, email: window.localStorage.getItem(EMAIL_KEY) };
  } catch {
    return { method: null, email: null };
  }
}
