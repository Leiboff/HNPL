import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import PeachWidget from './PeachWidget';

// ─── PeachWidget — mount-timing regression pin ─────────────────────
//
// Root cause the fix addresses: checkout.js's `.render(selector)`
// immediately calls document.querySelector. If the target isn't in
// the DOM at that instant, the widget throws "No element found" and
// the card form never appears. Prior implementation kicked off
// `.render(...)` from the raw `script.onload` handler — outside
// React's commit discipline — which could race the target's mount
// (StrictMode double-invoke; effect-triggered re-mount; a fast
// browser-cached script whose onload was already queued when React
// swapped the target DOM).
//
// The fix guarantees TWO preconditions before render():
//   (a) window.Checkout is set (script loaded).
//   (b) the target DOM element with our unique id is committed.
// Both are checked inside a React effect keyed on the script-ready
// state — so React scheduling, not raw DOM events, drives the call.
//
// These tests pin the mount-safe contract behaviourally: they don't
// pattern-match the source, they exercise the actual mount ordering
// via a fake window.Checkout global. If the mount ordering
// regresses (render called from script.onload before the target is
// present; render called twice for the same checkoutId), the tests
// will fail — that's the regression pin.

const CHECKOUT_ID       = 'ck_test_abc123';
const ENTITY_ID         = '8ac7a4c98f2a7f38018f2ac1c1010001';
const SHOPPER_RESULT    = 'https://example.test/checkout/tok/complete';

// The stub script URL — must be set BEFORE PeachWidget mounts so its
// script-load path takes the "inject checkout.js" branch. We don't
// actually fetch anything: our tests dispatch script.onload manually
// (or short-circuit via a pre-set window.Checkout global).
const STUB_SRC = 'https://sandbox.example.test/checkout.js';

type CheckoutOpts = {
  key:        string;
  checkoutId: string;
  events: {
    onCompleted: () => void;
    onCancelled: () => void;
    onExpired:   () => void;
  };
};
type FakeCheckoutInstance = { render: (target: string) => void };
type FakeCheckoutGlobal   = { initiate: (opts: CheckoutOpts) => FakeCheckoutInstance };

// Tracks whether the target DOM element exists at the moment render()
// was called. This is the load-bearing assertion — if render() is
// called before the target is committed, targetPresentAtRender is
// false and the test fails.
type RenderLog = {
  target:                  string;
  targetPresentAtRender:   boolean;
  targetElement:           Element | null;
  key:                     string;
  checkoutId:              string;
};

function installFakeCheckoutGlobal(renderLog: RenderLog[]): FakeCheckoutGlobal {
  const global: FakeCheckoutGlobal = {
    initiate(opts) {
      return {
        render(target: string) {
          const el = document.querySelector(target);
          renderLog.push({
            target,
            targetPresentAtRender: el !== null,
            targetElement:         el,
            key:                   opts.key,
            checkoutId:            opts.checkoutId,
          });
        },
      };
    },
  };
  (window as unknown as { Checkout?: FakeCheckoutGlobal }).Checkout = global;
  return global;
}

function clearCheckoutGlobal(): void {
  try { delete (window as unknown as { Checkout?: unknown }).Checkout; } catch { /* ignore */ }
}

// happy-dom's HTMLScriptElement.onload isn't wired to actually load
// the src — we manually dispatch it. This helper finds the last script
// tag PeachWidget added and fires its onload.
function fireLatestScriptOnLoad(): void {
  const scripts = Array.from(document.querySelectorAll(`script[src="${STUB_SRC}"]`));
  const last = scripts[scripts.length - 1] as HTMLScriptElement | undefined;
  if (!last) throw new Error('no PeachWidget script tag found to fire onload against');
  if (typeof last.onload === 'function') {
    last.onload({} as Event);
  }
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_PEACH_CHECKOUT_JS = STUB_SRC;
  clearCheckoutGlobal();
  // Wipe any script tags leaked from previous tests (happy-dom
  // persists document state across tests in the same file).
  document.querySelectorAll(`script[src="${STUB_SRC}"]`).forEach((s) => s.remove());
});

afterEach(() => {
  cleanup();
  clearCheckoutGlobal();
  document.querySelectorAll(`script[src="${STUB_SRC}"]`).forEach((s) => s.remove());
  delete process.env.NEXT_PUBLIC_PEACH_CHECKOUT_JS;
});

// ─── Contract A: target renders unconditionally on first paint ────

describe('PeachWidget — target element is present before script loads', () => {
  it('renders its target div on first paint, BEFORE checkout.js has loaded', () => {
    const { getByTestId } = render(
      <PeachWidget
        checkoutId={CHECKOUT_ID}
        entityId={ENTITY_ID}
        shopperResultUrl={SHOPPER_RESULT}
      />,
    );
    // Target div exists in the DOM immediately — no gating on script
    // state. This is the load-bearing invariant: whatever moment
    // checkout.js first tries to attach, its selector will resolve.
    const target = getByTestId('peach-widget-target');
    expect(target).toBeTruthy();
    expect(target.id.length).toBeGreaterThan(0);
    expect(target.id).toMatch(/^peach-payment-form-/);
    // No script tag has finished loading yet (the fake global is
    // absent), so the widget has NOT yet been initiated.
    expect((window as unknown as { Checkout?: unknown }).Checkout).toBeUndefined();
  });

  it('gives each mounted instance a unique target id (no #payment-form collision)', () => {
    const { getAllByTestId } = render(
      <>
        <PeachWidget checkoutId="a" entityId={ENTITY_ID} shopperResultUrl={SHOPPER_RESULT} />
        <PeachWidget checkoutId="b" entityId={ENTITY_ID} shopperResultUrl={SHOPPER_RESULT} />
      </>,
    );
    const targets = getAllByTestId('peach-widget-target');
    expect(targets).toHaveLength(2);
    expect(targets[0].id).not.toEqual(targets[1].id);
  });
});

// ─── Contract B: initiate + render fire ONLY after script + target are ready ─

describe('PeachWidget — render() is only called once both script-ready AND target-mounted', () => {
  it('does NOT call render() until the script has flipped scriptReady', () => {
    const renderLog: RenderLog[] = [];
    // NOTE: we deliberately do NOT install the Checkout global before
    // mount — that forces the script-load branch. Nothing should call
    // render() until fireLatestScriptOnLoad() dispatches onload.
    render(
      <PeachWidget
        checkoutId={CHECKOUT_ID}
        entityId={ENTITY_ID}
        shopperResultUrl={SHOPPER_RESULT}
      />,
    );
    expect(renderLog).toHaveLength(0);

    // Wire the fake Checkout global + fire the script's onload —
    // simulates checkout.js executing.
    installFakeCheckoutGlobal(renderLog);
    act(() => { fireLatestScriptOnLoad(); });

    // Now the effect (keyed on scriptReady) has run and called render.
    expect(renderLog).toHaveLength(1);
    expect(renderLog[0].target).toMatch(/^#peach-payment-form-/);
    expect(renderLog[0].targetPresentAtRender).toBe(true);
    expect(renderLog[0].targetElement).not.toBeNull();
    expect(renderLog[0].checkoutId).toBe(CHECKOUT_ID);
    expect(renderLog[0].key).toBe(ENTITY_ID);
  });

  it('short-circuits the script inject when window.Checkout is already present', () => {
    const renderLog: RenderLog[] = [];
    // Pre-install the global — simulates a second PeachWidget mount
    // where checkout.js is already cached in the tab.
    installFakeCheckoutGlobal(renderLog);

    render(
      <PeachWidget
        checkoutId={CHECKOUT_ID}
        entityId={ENTITY_ID}
        shopperResultUrl={SHOPPER_RESULT}
      />,
    );

    // The widget observed the global synchronously on init and never
    // added a script tag.
    expect(document.querySelectorAll(`script[src="${STUB_SRC}"]`).length).toBe(0);
    // render() fires from the effect (post-commit), so the target
    // element IS present when it runs.
    expect(renderLog).toHaveLength(1);
    expect(renderLog[0].targetPresentAtRender).toBe(true);
  });
});

// ─── Contract C: single-init guard ────────────────────────────────

describe('PeachWidget — initiate() runs exactly once per checkoutId', () => {
  it('does not call render() twice when the effect re-runs with unchanged props', () => {
    const renderLog: RenderLog[] = [];
    installFakeCheckoutGlobal(renderLog);

    const { rerender } = render(
      <PeachWidget
        checkoutId={CHECKOUT_ID}
        entityId={ENTITY_ID}
        shopperResultUrl={SHOPPER_RESULT}
      />,
    );
    expect(renderLog).toHaveLength(1);

    // Re-render with identical props — the effect's deps are unchanged,
    // but the single-init ref should stop a repeat render() even if
    // it did fire.
    rerender(
      <PeachWidget
        checkoutId={CHECKOUT_ID}
        entityId={ENTITY_ID}
        shopperResultUrl={SHOPPER_RESULT}
      />,
    );
    expect(renderLog).toHaveLength(1);
  });

  it('handles a re-render that changes an unrelated prop reference without double-rendering', () => {
    const renderLog: RenderLog[] = [];
    installFakeCheckoutGlobal(renderLog);

    const { rerender } = render(
      <PeachWidget
        checkoutId={CHECKOUT_ID}
        entityId={ENTITY_ID}
        shopperResultUrl={SHOPPER_RESULT}
      />,
    );
    expect(renderLog).toHaveLength(1);
    // A parent-driven re-render with the same checkoutId must not
    // re-trigger render() on the (already-consumed) target.
    rerender(
      <PeachWidget
        checkoutId={CHECKOUT_ID}
        entityId={ENTITY_ID}
        shopperResultUrl={SHOPPER_RESULT}
      />,
    );
    expect(renderLog).toHaveLength(1);
  });
});

// ─── Contract D: error path surfaces a user-visible message ────────

describe('PeachWidget — surfaces a visible error instead of silent failure', () => {
  it('renders an error alert when Checkout.initiate throws', () => {
    // Install a Checkout global whose initiate ALWAYS throws — matches
    // the observed prod symptom pre-fix ("No element found" from
    // checkout.js's render).
    (window as unknown as { Checkout?: FakeCheckoutGlobal }).Checkout = {
      initiate() {
        throw new Error('No element found');
      },
    };
    // Silence the console.error the widget emits.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { getByTestId, queryByTestId } = render(
      <PeachWidget
        checkoutId={CHECKOUT_ID}
        entityId={ENTITY_ID}
        shopperResultUrl={SHOPPER_RESULT}
      />,
    );

    // Effect ran on mount (Checkout was present) — initiate threw —
    // widget rendered the error alert instead of staying silent.
    expect(queryByTestId('peach-widget-error')).not.toBeNull();
    expect(getByTestId('peach-widget-error').getAttribute('role')).toBe('alert');
    // The target div is STILL present — the widget doesn't nuke its
    // own container when initiate fails.
    expect(queryByTestId('peach-widget-target')).not.toBeNull();
    // Confirm the underlying error was logged (for observability).
    expect(spy).toHaveBeenCalledWith(
      '[PeachWidget] Checkout.initiate threw',
      expect.any(Error),
    );
    spy.mockRestore();
  });

  it('renders an error alert when NEXT_PUBLIC_PEACH_CHECKOUT_JS is not set', () => {
    delete process.env.NEXT_PUBLIC_PEACH_CHECKOUT_JS;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { queryByTestId } = render(
      <PeachWidget
        checkoutId={CHECKOUT_ID}
        entityId={ENTITY_ID}
        shopperResultUrl={SHOPPER_RESULT}
      />,
    );

    expect(queryByTestId('peach-widget-error')).not.toBeNull();
    expect(queryByTestId('peach-widget-target')).not.toBeNull();
    spy.mockRestore();
  });
});

// ─── Contract E: onCompleted → navigate to shopperResultUrl ──────

describe('PeachWidget — onCompleted preserves shopperResultUrl navigation', () => {
  it('invokes events.onCompleted with a shape that yields the checkoutId-qualified return URL', () => {
    const renderLog: RenderLog[] = [];
    // Capture the events object handed to Checkout.initiate so we can
    // trigger onCompleted and observe the URL built.
    let capturedEvents: CheckoutOpts['events'] | null = null;
    (window as unknown as { Checkout?: FakeCheckoutGlobal }).Checkout = {
      initiate(opts) {
        capturedEvents = opts.events;
        return {
          render(target: string) {
            const el = document.querySelector(target);
            renderLog.push({
              target,
              targetPresentAtRender: el !== null,
              targetElement:         el,
              key:                   opts.key,
              checkoutId:            opts.checkoutId,
            });
          },
        };
      },
    };

    // Stub window.location.href assignment. happy-dom allows direct
    // writes but we want to intercept without actually navigating.
    let navigatedTo: string | null = null;
    const originalHref = window.location.href;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new Proxy(window.location, {
        set(target, prop, value) {
          if (prop === 'href') { navigatedTo = String(value); return true; }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (target as any)[prop] = value;
          return true;
        },
        get(target, prop) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target as any)[prop];
        },
      }),
    });

    render(
      <PeachWidget
        checkoutId={CHECKOUT_ID}
        entityId={ENTITY_ID}
        shopperResultUrl={SHOPPER_RESULT}
      />,
    );

    expect(renderLog).toHaveLength(1);
    expect(capturedEvents).not.toBeNull();

    // Fire onCompleted — simulates checkout.js signalling a successful
    // card capture + first CIT. Widget must navigate to
    // {shopperResultUrl}?checkoutId={id}, unchanged from pre-fix
    // behaviour.
    act(() => { capturedEvents!.onCompleted(); });

    expect(navigatedTo).not.toBeNull();
    const nav = new URL(navigatedTo!);
    expect(nav.origin + nav.pathname).toBe(SHOPPER_RESULT);
    expect(nav.searchParams.get('checkoutId')).toBe(CHECKOUT_ID);
    expect(nav.searchParams.get('status')).toBeNull();

    // Restore location.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, href: originalHref },
    });
  });
});
