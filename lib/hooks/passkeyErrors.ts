/**
 * Pure helpers for the patient passkey surfaces. Extracted from usePasskeys.ts
 * so unit tests can exercise them without bringing the React hook / Supabase
 * client into the test runtime. Hook + tests both import from here.
 */

export type PasskeyError =
  | 'passkey_disabled'
  | 'too_many_passkeys'
  | 'webauthn_credential_exists'
  | 'webauthn_credential_not_found'
  | 'webauthn_challenge_not_found'
  | 'webauthn_challenge_expired'
  | 'webauthn_verification_failed'
  | 'email_not_confirmed'
  | 'phone_not_confirmed'
  | 'user_banned'
  | 'user_cancelled'
  | 'unsupported'
  | 'unknown';

type RawError = { name?: string; code?: string; message?: string };

/**
 * Translate the various error shapes (Supabase auth error, DOMException from
 * the WebAuthn ceremony, plain throw) into one of our discriminated codes.
 */
export function mapPasskeyError(err: unknown): PasskeyError {
  if (!err || typeof err !== 'object') return 'unknown';
  const e = err as RawError;
  // WebAuthn ceremony cancellation comes through as a DOMException whose name
  // is NotAllowedError (user denied) or AbortError (timeout / programmatic abort).
  if (e.name === 'NotAllowedError' || e.name === 'AbortError') return 'user_cancelled';
  const code = e.code;
  if (code === 'passkey_disabled')              return 'passkey_disabled';
  if (code === 'too_many_passkeys')             return 'too_many_passkeys';
  if (code === 'webauthn_credential_exists')    return 'webauthn_credential_exists';
  if (code === 'webauthn_credential_not_found') return 'webauthn_credential_not_found';
  if (code === 'webauthn_challenge_not_found')  return 'webauthn_challenge_not_found';
  if (code === 'webauthn_challenge_expired')    return 'webauthn_challenge_expired';
  if (code === 'webauthn_verification_failed')  return 'webauthn_verification_failed';
  if (code === 'email_not_confirmed')           return 'email_not_confirmed';
  if (code === 'phone_not_confirmed')           return 'phone_not_confirmed';
  if (code === 'user_banned')                   return 'user_banned';
  return 'unknown';
}

/**
 * User-facing copy for each PasskeyError code. user_cancelled returns an
 * empty string deliberately — UI uses that as a signal to suppress display.
 */
export function passkeyErrorMessage(code: PasskeyError): string {
  switch (code) {
    case 'passkey_disabled':              return 'Passkey sign-in is not enabled for this account.';
    case 'too_many_passkeys':             return 'You’ve reached the maximum number of passkeys. Delete one to add another.';
    case 'webauthn_credential_exists':    return 'This device already has a passkey registered.';
    case 'webauthn_credential_not_found': return 'That passkey isn’t registered with this account.';
    case 'webauthn_challenge_not_found':  return 'Something went wrong starting the passkey ceremony. Please try again.';
    case 'webauthn_challenge_expired':    return 'The passkey prompt timed out. Please try again.';
    case 'webauthn_verification_failed':  return 'We couldn’t verify that passkey. Please try again.';
    case 'email_not_confirmed':           return 'Please confirm your email address before signing in.';
    case 'phone_not_confirmed':           return 'Please confirm your phone number before signing in.';
    case 'user_banned':                   return 'This account is suspended. Contact support.';
    case 'user_cancelled':                return '';
    case 'unsupported':                   return 'Passkeys aren’t supported in this browser.';
    case 'unknown':                       return 'Something went wrong. Please try again.';
  }
}
