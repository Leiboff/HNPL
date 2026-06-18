import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ─── usePasskeySignIn — silent-degrade contract ──────────────────────────
//
// The patient was seeing "Something went wrong. Please try again." on the
// login page on devices where WebAuthn behaves differently (in-app
// webviews, Brave with strict shields, some Android Chromium forks). The
// trigger was the auto-started conditional UI ceremony — a path the
// patient never clicked.
//
// These tests pin the contract that the auto-start path:
//   1. Hides the button when feature-detect itself THROWS (vs. just
//      returning false). A throwing probe is a strong "passkeys are
//      broken in this runtime" signal — we'd rather show the password
//      form than risk a half-working passkey button.
//   2. Returning false from the probe is NOT a throw — keep the button
//      (iOS Safari has passkeys but no autofill; modal path works).
//   3. Conditional ceremony failures are LOGGED but never setError —
//      no banner can ever appear from a path the patient didn't trigger.
//
// And critically the happy-path inverse — the EXPLICIT signIn() button
// click STILL surfaces real failures. We didn't fix degradation by
// breaking the regular auth path.

// ── Mocks BEFORE importing the hook ──────────────────────────────────

const passkeySignInMock                = vi.fn();
const browserSupportsAutofillMock      = vi.fn();
const cancelCeremonyMock               = vi.fn();

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthnAutofill: () => browserSupportsAutofillMock(),
  WebAuthnAbortService:            { cancelCeremony: () => cancelCeremonyMock() },
}));

vi.mock('@/lib/auth/passkeySignIn', () => ({
  passkeySignIn: (opts: { conditional?: boolean }) => passkeySignInMock(opts),
}));

// ── PublicKeyCredential stub on window so the synchronous feature check passes ──
// happy-dom doesn't ship this, so we install a placeholder. Tests that
// want the "no WebAuthn" case delete it explicitly.

beforeEach(() => {
  passkeySignInMock.mockReset();
  browserSupportsAutofillMock.mockReset();
  cancelCeremonyMock.mockReset();
  (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};
});

import { usePasskeySignIn } from './usePasskeySignIn';

describe('usePasskeySignIn — silent-degrade contract', () => {
  it('hides the button when feature detection finds no PublicKeyCredential', async () => {
    delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    const { result } = renderHook(() => usePasskeySignIn({ onSuccess: vi.fn() }));
    // Synchronous: supported stays false because there's nothing to probe.
    expect(result.current.supported).toBe(false);
    expect(result.current.error).toBeNull();
    expect(browserSupportsAutofillMock).not.toHaveBeenCalled();
  });

  it('a THROWING autofill probe hides the button + never sets error', async () => {
    // browserSupportsWebAuthnAutofill internally calls
    // PublicKeyCredential.isConditionalMediationAvailable() — on some
    // browsers (Brave strict, in-app webviews) this throws. Was the
    // primary trigger of the intermittent banner.
    browserSupportsAutofillMock.mockRejectedValue(new Error('isConditionalMediationAvailable threw'));

    const { result } = renderHook(() => usePasskeySignIn({ onSuccess: vi.fn() }));

    await waitFor(() => {
      expect(browserSupportsAutofillMock).toHaveBeenCalled();
    });
    // Critical: button now hidden, NO error surfaced.
    await waitFor(() => expect(result.current.supported).toBe(false));
    expect(result.current.error).toBeNull();
    // Ceremony must NOT have been attempted after a probe throw.
    expect(passkeySignInMock).not.toHaveBeenCalled();
  });

  it('autofill RETURNING FALSE keeps the button (iOS Safari case)', async () => {
    // No throw — just an honest "I don't support autofill". The modal
    // button is still useful here (iOS Safari supports passkeys
    // modally even though it doesn't expose autofill).
    browserSupportsAutofillMock.mockResolvedValue(false);

    const { result } = renderHook(() => usePasskeySignIn({ onSuccess: vi.fn() }));

    await waitFor(() => expect(browserSupportsAutofillMock).toHaveBeenCalled());
    expect(result.current.supported).toBe(true);
    expect(result.current.error).toBeNull();
    // Ceremony not started — autofill was unavailable.
    expect(passkeySignInMock).not.toHaveBeenCalled();
  });

  it('conditional ceremony FAILURE never sets a page error (silent degrade)', async () => {
    // The case the user reported: autofill available, ceremony fires,
    // ceremony throws a DOMException that doesn't map to user_cancelled.
    // Before the fix, this surfaced "Something went wrong. Please try again."
    browserSupportsAutofillMock.mockResolvedValue(true);
    const invalidStateErr = Object.assign(new Error('Invalid state'), {
      name: 'InvalidStateError',
    });
    passkeySignInMock.mockRejectedValue(invalidStateErr);

    const onSuccess = vi.fn();
    const { result } = renderHook(() => usePasskeySignIn({ onSuccess }));

    await waitFor(() => expect(passkeySignInMock).toHaveBeenCalledWith({ conditional: true }));
    // No error surfaced; no onSuccess; button still there.
    expect(result.current.error).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.supported).toBe(true);
  });

  it('conditional ceremony SUCCESS calls onSuccess (happy autofill path)', async () => {
    browserSupportsAutofillMock.mockResolvedValue(true);
    passkeySignInMock.mockResolvedValue(undefined);

    const onSuccess = vi.fn();
    renderHook(() => usePasskeySignIn({ onSuccess }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });
});

describe('usePasskeySignIn — explicit signIn (button click) preserves real errors', () => {
  it('a real ceremony failure on the explicit path STILL surfaces an error', async () => {
    // This is the inverse — we didn't break the happy path while
    // fixing the silent-probe path. A real button click that fails
    // must still tell the patient.
    browserSupportsAutofillMock.mockResolvedValue(false);  // no autofill, no auto-start
    passkeySignInMock.mockRejectedValueOnce(Object.assign(new Error('challenge expired'), {
      code: 'webauthn_challenge_expired',
    }));

    const { result } = renderHook(() => usePasskeySignIn({ onSuccess: vi.fn() }));
    await waitFor(() => expect(result.current.supported).toBe(true));

    let outcome: { error: string | null } | undefined;
    await act(async () => {
      outcome = await result.current.signIn();
    });

    expect(outcome!.error).toBe('webauthn_challenge_expired');
    expect(result.current.error).toBe('webauthn_challenge_expired');
  });

  it('a user-cancelled explicit click is silent (no banner for closing the OS sheet)', async () => {
    browserSupportsAutofillMock.mockResolvedValue(false);
    const notAllowed = Object.assign(new Error('user cancelled'), { name: 'NotAllowedError' });
    passkeySignInMock.mockRejectedValueOnce(notAllowed);

    const { result } = renderHook(() => usePasskeySignIn({ onSuccess: vi.fn() }));
    await waitFor(() => expect(result.current.supported).toBe(true));

    let outcome: { error: string | null } | undefined;
    await act(async () => {
      outcome = await result.current.signIn();
    });

    // Returned to the caller for diagnostic purposes, but NOT surfaced.
    expect(outcome!.error).toBe('user_cancelled');
    expect(result.current.error).toBeNull();
  });

  it('a successful explicit click calls onSuccess', async () => {
    browserSupportsAutofillMock.mockResolvedValue(false);
    passkeySignInMock.mockResolvedValueOnce(undefined);

    const onSuccess = vi.fn();
    const { result } = renderHook(() => usePasskeySignIn({ onSuccess }));
    await waitFor(() => expect(result.current.supported).toBe(true));

    await act(async () => { await result.current.signIn(); });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
