'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { browserSupportsWebAuthnAutofill, WebAuthnAbortService } from '@simplewebauthn/browser';
import { passkeySignIn } from '@/lib/auth/passkeySignIn';
import { mapPasskeyError, type PasskeyError } from './passkeyErrors';

/**
 * Login-page hook handling both conditional UI (passkey-as-autofill) and the
 * explicit modal sign-in button. Wraps the lifecycle: feature detection,
 * mounting the conditional ceremony, aborting it on unmount, and normalising
 * errors from the EXPLICIT path.
 *
 * Conditional UI is the "almost immediate" experience: when the user focuses
 * the email input on a device with passkey + autofill support, the browser
 * surfaces their saved passkey as a suggestion. One tap → Face ID → signed
 * in. No explicit button needed.
 *
 * Requirements for conditional UI to actually trigger:
 *   1. The browser supports it — see `browserSupportsWebAuthnAutofill()`.
 *   2. An `<input autocomplete="username webauthn">` is in the DOM by the
 *      time `startAuthentication({ useBrowserAutofill: true })` runs.
 *   3. The user has a passkey registered for the RP.
 *
 * ─── Silent-degrade contract (added 2026-06-18) ──────────────────────────
 *
 * The conditional/probe path is BEST-EFFORT enrichment. The user did NOT
 * click anything to start it — we did, on page mount. Therefore any failure
 * along the probe path MUST NOT surface a page-level error to the patient.
 *
 * Specifically:
 *   • Feature detection (`PublicKeyCredential in window`) is wrapped in
 *     try/catch — some sandboxed iframes / strict CSP contexts throw on
 *     window-property access.
 *   • `browserSupportsWebAuthnAutofill()` is wrapped in try/catch. The
 *     library internally calls `PublicKeyCredential.isConditionalMediation
 *     Available()` which throws on certain in-app webviews, some Android
 *     Chromium forks, and Brave with strict shields. On throw we treat
 *     passkeys as unavailable here and hide the button.
 *   • The auto-started conditional ceremony's errors are LOGGED but never
 *     setError'd. Mapping them through `mapPasskeyError` for an `unknown`
 *     code would surface "Something went wrong. Please try again." for
 *     things the patient never asked to happen — that was the regression
 *     this hook now guards against.
 *
 * The EXPLICIT `signIn()` path (modal button click) keeps the original
 * behaviour: real failures of a real auth attempt SHOULD be visible.
 */
export function usePasskeySignIn({ onSuccess }: { onSuccess: () => void }) {
  const [supported,         setSupported]         = useState(false);
  const [conditionalActive, setConditionalActive] = useState(false);
  const [loading,           setLoading]           = useState(false);
  const [error,             setError]             = useState<PasskeyError | null>(null);

  // Hold the latest onSuccess in a ref so the conditional-UI effect doesn't
  // re-mount every time the parent re-renders.
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  useEffect(() => {
    // ── Feature detection (synchronous) ─────────────────────────────────
    // Wrapped in try/catch because sandboxed iframes and strict CSP can
    // throw on accessing window properties (uncommon, but real).
    let hasWebAuthn = false;
    try {
      hasWebAuthn = typeof window !== 'undefined' && 'PublicKeyCredential' in window;
    } catch {
      hasWebAuthn = false;
    }
    if (!hasWebAuthn) {
      // supported stays false → the button is hidden, the password form
      // is the only path. That's the right fallback.
      return;
    }
    setSupported(true);

    let cancelled = false;

    (async () => {
      // ── Autofill probe (best-effort) ─────────────────────────────────
      // browserSupportsWebAuthnAutofill internally calls
      // PublicKeyCredential.isConditionalMediationAvailable() — this throws
      // on some in-app webviews / Brave Strict / older Android Chromiums.
      // On throw: degrade silently AND hide the button (a probe that
      // throws is a strong "passkeys are broken in this runtime" signal).
      // On returns-false: leave the button alone — modal sign-in can
      // still work on browsers without autofill (iOS Safari).
      let autofillAvailable = false;
      try {
        autofillAvailable = await browserSupportsWebAuthnAutofill();
      } catch (probeErr) {
        if (cancelled) return;
        console.warn(
          '[passkey] autofill probe threw — hiding button (silent degrade)',
          probeErr instanceof Error ? probeErr.message : probeErr,
        );
        setSupported(false);
        return;
      }
      if (!autofillAvailable || cancelled) return;

      // ── Conditional ceremony (best-effort) ───────────────────────────
      // We auto-start this on mount; the patient never clicked anything.
      // ANY failure here — Supabase error, WebAuthn ceremony exception,
      // network blip — must NOT surface a page-level banner. Log for ops
      // visibility, then quietly fall back to the password form (which
      // is right there on the same page).
      setConditionalActive(true);
      try {
        await passkeySignIn({ conditional: true });
        if (cancelled) return;
        onSuccessRef.current();
      } catch (err) {
        if (cancelled) return;
        const code = mapPasskeyError(err);
        if (code !== 'user_cancelled') {
          // Probe ceremony failures are diagnostic-only. The two reasons
          // we DO NOT setError here:
          //   1. The patient never asked us to start this ceremony.
          //   2. Mapping a DOMException like InvalidStateError /
          //      NotSupportedError / SecurityError / NetworkError /
          //      EncodingError to 'unknown' would surface "Something
          //      went wrong. Please try again." — the bug this hook now
          //      explicitly guards against.
          console.warn(
            '[passkey] conditional sign-in failed — silent degrade',
            { code, message: (err as { message?: string }).message },
          );
        }
      } finally {
        if (!cancelled) setConditionalActive(false);
      }
    })();

    return () => {
      cancelled = true;
      // Cleans up any in-flight ceremony on navigation/unmount. Calling
      // startAuthentication again (modal path below) also triggers an
      // abort internally, so the two paths don't collide. Wrapped in
      // try/catch as defence — the library's cancelCeremony() has been
      // observed to throw on some browsers in race conditions.
      try { WebAuthnAbortService.cancelCeremony(); } catch { /* ignore */ }
    };
  }, []);

  const signIn = useCallback(async (): Promise<{ error: PasskeyError | null }> => {
    if (!supported) return { error: 'unsupported' };
    setLoading(true);
    setError(null);
    try {
      await passkeySignIn({ conditional: false });
      onSuccessRef.current();
      return { error: null };
    } catch (err) {
      const code = mapPasskeyError(err);
      // Explicit-click failures DO surface — the patient pressed the
      // button and is owed a result. user_cancelled stays silent
      // (it's the patient closing the OS sheet, not an error).
      if (code !== 'user_cancelled') setError(code);
      return { error: code };
    } finally {
      setLoading(false);
    }
  }, [supported]);

  return { supported, signIn, loading, error, conditionalActive };
}
