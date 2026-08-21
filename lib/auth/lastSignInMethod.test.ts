import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getLastSignInMethod, setLastSignInMethod } from './lastSignInMethod';

// ─── lib/auth/lastSignInMethod — the localStorage hint, not a security gate ─

beforeEach(() => {
  window.localStorage.clear();
});

describe('round trip', () => {
  it('password: stores the method and the email together', () => {
    setLastSignInMethod('password', 'thandi@example.com');
    expect(getLastSignInMethod()).toEqual({ method: 'password', email: 'thandi@example.com' });
  });

  it('google: stores the method with no email', () => {
    setLastSignInMethod('google');
    expect(getLastSignInMethod()).toEqual({ method: 'google', email: null });
  });

  it('passkey: stores the method with no email', () => {
    setLastSignInMethod('passkey');
    expect(getLastSignInMethod()).toEqual({ method: 'passkey', email: null });
  });

  it('nothing stored yet: both come back null', () => {
    expect(getLastSignInMethod()).toEqual({ method: null, email: null });
  });
});

describe('a later Google/passkey sign-in clears a stale password email', () => {
  it('signing in with Google after password does not leave the old email behind', () => {
    setLastSignInMethod('password', 'old@example.com');
    setLastSignInMethod('google');
    expect(getLastSignInMethod()).toEqual({ method: 'google', email: null });
  });

  it('signing in with passkey after password does not leave the old email behind', () => {
    setLastSignInMethod('password', 'old@example.com');
    setLastSignInMethod('passkey');
    expect(getLastSignInMethod()).toEqual({ method: 'passkey', email: null });
  });

  it('switching back to password later is unaffected by the intervening clear', () => {
    setLastSignInMethod('password', 'old@example.com');
    setLastSignInMethod('google');
    setLastSignInMethod('password', 'new@example.com');
    expect(getLastSignInMethod()).toEqual({ method: 'password', email: 'new@example.com' });
  });
});

describe('a stray or corrupted value never reaches a caller as the method', () => {
  it('an unrecognised stored method reads back as null, not the raw string', () => {
    window.localStorage.setItem('bn_last_signin_method', 'fingerprint');
    expect(getLastSignInMethod()).toEqual({ method: null, email: null });
  });
});

describe('storage errors are swallowed — this is a cosmetic hint, never load-bearing', () => {
  it('setLastSignInMethod does not throw when localStorage.setItem throws', () => {
    const spy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setLastSignInMethod('password', 'a@b.com')).not.toThrow();
    spy.mockRestore();
  });

  it('getLastSignInMethod returns nulls, not a throw, when localStorage.getItem throws', () => {
    const spy = vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(getLastSignInMethod()).toEqual({ method: null, email: null });
    spy.mockRestore();
  });
});
