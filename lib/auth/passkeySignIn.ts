'use client';

import {
  startAuthentication,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { createClient } from '@/lib/supabase/client';

/**
 * Sign in with a passkey via the two-step low-level API. Used for both the
 * conditional UI (autofill suggestion) and the explicit modal flow on the
 * login page — `conditional` flips `useBrowserAutofill` on the underlying
 * `navigator.credentials.get()` call.
 *
 * We use the low-level path (not Supabase's high-level `signInWithPasskey`)
 * specifically because the high-level method has no mediation option. The
 * Supabase server-issued `options` is already a `PublicKeyCredentialRequestOptionsJSON`,
 * so @simplewebauthn/browser can consume it directly; we hand the resulting
 * credential straight back to `verifyAuthentication`.
 *
 * The two libraries define their own (structurally compatible but nominally
 * distinct) JSON types — we cast at the boundary rather than copy-converting.
 *
 * Throws on any error so the caller can map via `mapPasskeyError`.
 */
export async function passkeySignIn(
  { conditional = false }: { conditional?: boolean } = {},
) {
  const supabase = createClient();

  const { data: optionsData, error: optErr } = await supabase.auth.passkey.startAuthentication();
  if (optErr) throw optErr;
  if (!optionsData) throw new Error('No options returned from startAuthentication');

  const credential = await startAuthentication({
    optionsJSON:        optionsData.options as unknown as PublicKeyCredentialRequestOptionsJSON,
    useBrowserAutofill: conditional,
    // verifyBrowserAutofillInput defaults to true — requires an input with
    // autocomplete="username webauthn" in the DOM when conditional is true.
  });

  const { data, error: verifyErr } = await supabase.auth.passkey.verifyAuthentication({
    challengeId: optionsData.challenge_id,
    credential: credential as unknown as Parameters<
      typeof supabase.auth.passkey.verifyAuthentication
    >[0]['credential'],
  });
  if (verifyErr) throw verifyErr;

  return data;
}

// Re-export the @simplewebauthn AuthenticationResponseJSON for callers that
// need the credential shape.
export type { AuthenticationResponseJSON };
