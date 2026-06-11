import { describe, it, expect } from 'vitest';
import { mapPasskeyError, passkeyErrorMessage, type PasskeyError } from './passkeyErrors';

// ─── mapPasskeyError ────────────────────────────────────────────────────────
//
// This is the function that decides "what kind of failure is this?" Every
// passkey surface (login button, post-login prompt, settings) reads its
// output to choose between silent return, retryable error message, and
// terminal error message. Worth thorough coverage.

describe('mapPasskeyError', () => {
  describe('WebAuthn ceremony cancellation (DOMException)', () => {
    it('maps NotAllowedError to user_cancelled (user rejected prompt)', () => {
      expect(mapPasskeyError({ name: 'NotAllowedError', message: 'denied' })).toBe('user_cancelled');
    });

    it('maps AbortError to user_cancelled (timeout or abort signal)', () => {
      expect(mapPasskeyError({ name: 'AbortError' })).toBe('user_cancelled');
    });

    it('treats a real DOMException instance the same way', () => {
      // Simulate the actual DOMException shape browsers throw.
      const e = Object.assign(new Error('user denied'), { name: 'NotAllowedError' });
      expect(mapPasskeyError(e)).toBe('user_cancelled');
    });
  });

  describe('Supabase error codes', () => {
    const cases: [string, PasskeyError][] = [
      ['passkey_disabled',              'passkey_disabled'],
      ['too_many_passkeys',             'too_many_passkeys'],
      ['webauthn_credential_exists',    'webauthn_credential_exists'],
      ['webauthn_credential_not_found', 'webauthn_credential_not_found'],
      ['webauthn_challenge_not_found',  'webauthn_challenge_not_found'],
      ['webauthn_challenge_expired',    'webauthn_challenge_expired'],
      ['webauthn_verification_failed',  'webauthn_verification_failed'],
      ['email_not_confirmed',           'email_not_confirmed'],
      ['phone_not_confirmed',           'phone_not_confirmed'],
      ['user_banned',                   'user_banned'],
    ];

    for (const [code, expected] of cases) {
      it(`maps code=${code} to ${expected}`, () => {
        expect(mapPasskeyError({ code, message: 'whatever' })).toBe(expected);
      });
    }
  });

  describe('fallbacks', () => {
    it('returns unknown for null', () => {
      expect(mapPasskeyError(null)).toBe('unknown');
    });

    it('returns unknown for undefined', () => {
      expect(mapPasskeyError(undefined)).toBe('unknown');
    });

    it('returns unknown for a string', () => {
      expect(mapPasskeyError('not an error object')).toBe('unknown');
    });

    it('returns unknown for an empty object', () => {
      expect(mapPasskeyError({})).toBe('unknown');
    });

    it('returns unknown for an unrecognised code', () => {
      expect(mapPasskeyError({ code: 'some_new_code_we_dont_know' })).toBe('unknown');
    });

    it('prefers DOMException name over code when both look applicable', () => {
      // If somehow both name and code arrive — name wins (it's the more
      // specific signal coming from the WebAuthn ceremony itself).
      expect(mapPasskeyError({ name: 'NotAllowedError', code: 'webauthn_verification_failed' }))
        .toBe('user_cancelled');
    });
  });
});

// ─── passkeyErrorMessage ────────────────────────────────────────────────────
//
// Verifies every PasskeyError code has a defined user-facing message and that
// the `user_cancelled` case returns an empty string (UI uses that as a signal
// to suppress error display entirely).

describe('passkeyErrorMessage', () => {
  const allCodes: PasskeyError[] = [
    'passkey_disabled',
    'too_many_passkeys',
    'webauthn_credential_exists',
    'webauthn_credential_not_found',
    'webauthn_challenge_not_found',
    'webauthn_challenge_expired',
    'webauthn_verification_failed',
    'email_not_confirmed',
    'phone_not_confirmed',
    'user_banned',
    'user_cancelled',
    'unsupported',
    'unknown',
  ];

  it('returns an empty string for user_cancelled (intentional)', () => {
    expect(passkeyErrorMessage('user_cancelled')).toBe('');
  });

  it.each(allCodes.filter((c) => c !== 'user_cancelled'))(
    'returns a non-empty user-facing string for %s',
    (code) => {
      const msg = passkeyErrorMessage(code);
      expect(msg).toBeTruthy();
      expect(msg.length).toBeGreaterThan(10);  // sanity: not a stub
    },
  );
});
