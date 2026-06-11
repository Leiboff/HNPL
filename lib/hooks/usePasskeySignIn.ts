'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { browserSupportsWebAuthnAutofill, WebAuthnAbortService } from '@simplewebauthn/browser';
import { passkeySignIn } from '@/lib/auth/passkeySignIn';
import { mapPasskeyError, type PasskeyError } from './passkeyErrors';

/**
 * Login-page hook handling both conditional UI (passkey-as-autofill) and the
 * explicit modal sign-in button. Wraps the lifecycle: feature detection,
 * mounting the conditional ceremony, aborting it on unmount or when the
 * user triggers the modal path, and normalising errors.
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
    const hasWebAuthn = typeof window !== 'undefined' && 'PublicKeyCredential' in window;
    setSupported(hasWebAuthn);
    if (!hasWebAuthn) return;

    let cancelled = false;

    (async () => {
      const autofillAvailable = await browserSupportsWebAuthnAutofill();
      if (!autofillAvailable || cancelled) return;

      setConditionalActive(true);
      try {
        await passkeySignIn({ conditional: true });
        if (cancelled) return;
        onSuccessRef.current();
      } catch (err) {
        if (cancelled) return;
        const code = mapPasskeyError(err);
        // Conditional UI cancellations (e.g. user closes the autofill chip)
        // are expected — don't surface as an error.
        if (code !== 'user_cancelled') setError(code);
      } finally {
        if (!cancelled) setConditionalActive(false);
      }
    })();

    return () => {
      cancelled = true;
      // Cleans up any in-flight ceremony on navigation/unmount. Calling
      // startAuthentication again (modal path below) also triggers an abort
      // internally, so the two paths don't collide.
      WebAuthnAbortService.cancelCeremony();
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
      if (code !== 'user_cancelled') setError(code);
      return { error: code };
    } finally {
      setLoading(false);
    }
  }, [supported]);

  return { supported, signIn, loading, error, conditionalActive };
}
