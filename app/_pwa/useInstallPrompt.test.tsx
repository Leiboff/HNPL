import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ─── useInstallPrompt — install lifecycle contract ───────────────────────
//
// The hook is the single source of truth for both surfaces that offer
// PWA install (the corner toast + the placed login-page callout). It
// has to collapse the messy browser reality into one tidy state value:
//
//   • 'installed' — already running standalone; nothing to offer.
//   • 'android'   — Chrome captured beforeinstallprompt; we can install.
//   • 'ios'       — iOS Safari; no JS API, hint-only.
//   • 'none'      — desktop browser without install support, in-app
//                   webview, etc.
//
// These tests pin each path so a future refactor of detection doesn't
// silently change which surface renders where.

type WindowWithUA = Window & {
  matchMedia?: (q: string) => MediaQueryList;
};

const originalMatchMedia = (typeof window !== 'undefined') ? window.matchMedia : undefined;
const originalUA         = (typeof navigator !== 'undefined') ? navigator.userAgent : '';
const originalPlatform   = (typeof navigator !== 'undefined') ? navigator.platform  : '';
const originalStandalone = (typeof navigator !== 'undefined')
  ? (navigator as Navigator & { standalone?: boolean }).standalone : undefined;

function setUA(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}
function setPlatform(p: string) {
  Object.defineProperty(navigator, 'platform', { value: p, configurable: true });
}
function setStandalone(v: boolean | undefined) {
  Object.defineProperty(navigator, 'standalone', { value: v, configurable: true });
}
function setMatchMediaStandalone(matches: boolean) {
  (window as WindowWithUA).matchMedia = (q: string) => ({
    matches:   q === '(display-mode: standalone)' ? matches : false,
    media:     q,
    addEventListener:    vi.fn(),
    removeEventListener: vi.fn(),
    addListener:         vi.fn(),
    removeListener:      vi.fn(),
    dispatchEvent:       vi.fn(),
    onchange:            null,
  } as unknown as MediaQueryList);
}

beforeEach(() => {
  setUA('');
  setPlatform('Win32');
  setStandalone(undefined);
  setMatchMediaStandalone(false);
});

afterEach(() => {
  // Defence in depth — restore navigator props between tests so a
  // leaking userAgent / platform value doesn't bleed across cases.
  setUA(originalUA);
  setPlatform(originalPlatform);
  setStandalone(originalStandalone);
  if (originalMatchMedia) (window as WindowWithUA).matchMedia = originalMatchMedia;
});

import { useInstallPrompt } from './useInstallPrompt';

describe('useInstallPrompt — state transitions', () => {
  it('reports "installed" when display-mode is standalone (Android installed)', async () => {
    setMatchMediaStandalone(true);
    const { result } = renderHook(() => useInstallPrompt());
    await waitFor(() => expect(result.current.state).toBe('installed'));
  });

  it('reports "installed" when iOS navigator.standalone === true (legacy iOS)', async () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1');
    setStandalone(true);
    const { result } = renderHook(() => useInstallPrompt());
    await waitFor(() => expect(result.current.state).toBe('installed'));
  });

  it('reports "ios" on iOS Safari (no beforeinstallprompt; show share-hint)', async () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
    const { result } = renderHook(() => useInstallPrompt());
    await waitFor(() => expect(result.current.state).toBe('ios'));
  });

  it('reports "none" on Chrome-on-iOS (CriOS UA — install not available)', async () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/120.0 Mobile/15E148 Safari/604.1');
    const { result } = renderHook(() => useInstallPrompt());
    // No beforeinstallprompt fires AND not iOS Safari → 'none'.
    await waitFor(() => expect(result.current.state).toBe('none'));
  });

  it('reports "android" once beforeinstallprompt has fired (and install() resolves)', async () => {
    setUA('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36');

    const { result } = renderHook(() => useInstallPrompt());

    // Synthesise the event the browser dispatches when the install
    // criteria are met. The hook captures + preventDefault()'s it.
    const evt = new Event('beforeinstallprompt');
    const prompt = vi.fn().mockResolvedValue(undefined);
    const userChoice = Promise.resolve({ outcome: 'accepted' as const });
    Object.assign(evt, { prompt, userChoice });

    act(() => { window.dispatchEvent(evt); });

    await waitFor(() => expect(result.current.state).toBe('android'));

    // install() calls .prompt() and returns the choice outcome.
    let outcome: { outcome?: 'accepted' | 'dismissed' } | undefined;
    await act(async () => { outcome = await result.current.install(); });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(outcome?.outcome).toBe('accepted');
  });

  it('appinstalled flips to "installed" without a reload', async () => {
    setUA('Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36');
    const { result } = renderHook(() => useInstallPrompt());

    act(() => { window.dispatchEvent(new Event('appinstalled')); });
    await waitFor(() => expect(result.current.state).toBe('installed'));
  });
});
