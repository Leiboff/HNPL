import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { usePendingAction } from './usePendingAction';
import {
  PENDING_LABEL_DELAY_MS,
  PENDING_LABEL_MIN_MS,
} from './timing';

// ─── The three timing rules, driven through a real component ─────────────
//
//   1. disabled is TRUE IMMEDIATELY — the double-submit guard, never delayed.
//   2. showLabel waits out PENDING_LABEL_DELAY_MS — no flash on fast actions.
//   3. once shown, showLabel is held PENDING_LABEL_MIN_MS — no flash on
//      actions that finish just past the delay.
//
// Rule 1 is the one with real consequences: a guard that waits 150 ms is
// not a guard, because 150 ms is comfortably inside the window where an
// impatient user double-taps a slow button on a phone. The double-tap test
// below is the one that would catch a regression that mattered.

/** A button wired the way the real call sites are. */
function Harness({ onRun }: { onRun: () => Promise<unknown> }) {
  const pending = usePendingAction();
  return (
    <button
      type="button"
      disabled={pending.disabled}
      data-testid="btn"
      onClick={() => { void pending.run(onRun); }}
    >
      {pending.showLabel ? 'Saving…' : 'Save'}
    </button>
  );
}

/** The useTransition-shaped call site: an external flag is mirrored. */
function MirrorHarness() {
  const [flag, setFlag] = useState(false);
  const pending = usePendingAction({ pending: flag });
  return (
    <>
      <button data-testid="btn" disabled={pending.disabled}>
        {pending.showLabel ? 'Saving…' : 'Save'}
      </button>
      <button data-testid="on"  onClick={() => setFlag(true)}>on</button>
      <button data-testid="off" onClick={() => setFlag(false)}>off</button>
    </>
  );
}

const btn   = () => screen.getByTestId('btn') as HTMLButtonElement;
const label = () => btn().textContent;

/** Advance timers and flush React. */
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('rule 1 — disabled is immediate, never delayed', () => {
  it('disables on the very first click, before any timer runs', async () => {
    const onRun = vi.fn(() => new Promise(() => {}));   // never settles
    render(<Harness onRun={onRun} />);
    expect(btn().disabled).toBe(false);

    await act(async () => { btn().click(); });

    // No timers advanced at all.
    expect(btn().disabled).toBe(true);
  });

  it('ADVERSARIAL: a double-tap inside the delay window submits ONCE', async () => {
    // The regression that would actually cost money — a second charge, a
    // duplicate bill. 150 ms is well within human double-tap range, so a
    // guard that waited for the delay would let this through.
    const onRun = vi.fn(() => new Promise(() => {}));
    render(<Harness onRun={onRun} />);

    await act(async () => { btn().click(); });
    await advance(10);
    await act(async () => { btn().click(); });
    await act(async () => { btn().click(); });

    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('a rapid triple-tap with no time between submits once', async () => {
    const onRun = vi.fn(() => new Promise(() => {}));
    render(<Harness onRun={onRun} />);
    await act(async () => { btn().click(); btn().click(); btn().click(); });
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('re-enables once the work settles', async () => {
    let release!: () => void;
    const onRun = () => new Promise<void>((r) => { release = r; });
    render(<Harness onRun={onRun} />);

    await act(async () => { btn().click(); });
    expect(btn().disabled).toBe(true);

    await act(async () => { release(); });
    await advance(PENDING_LABEL_MIN_MS);
    expect(btn().disabled).toBe(false);
  });

  it('re-enables even when the action REJECTS, and re-throws', async () => {
    // A button left permanently disabled by a failed action is a dead
    // screen. The rejection must still reach the caller's error handling.
    const onRun = () => Promise.reject(new Error('boom'));
    const seen: unknown[] = [];
    function RejectHarness() {
      const pending = usePendingAction();
      return (
        <button
          data-testid="btn"
          disabled={pending.disabled}
          onClick={() => { pending.run(onRun).catch((e) => seen.push(e)); }}
        >
          {pending.showLabel ? 'Saving…' : 'Save'}
        </button>
      );
    }
    render(<RejectHarness />);
    await act(async () => { btn().click(); });
    await advance(PENDING_LABEL_MIN_MS);

    expect(btn().disabled).toBe(false);
    expect(seen).toHaveLength(1);
  });
});

describe('rule 2 — a fast action never flashes a label', () => {
  it('shows nothing at all when the work finishes under the delay', async () => {
    let release!: () => void;
    const onRun = () => new Promise<void>((r) => { release = r; });
    render(<Harness onRun={onRun} />);

    await act(async () => { btn().click(); });
    expect(label()).toBe('Save');          // disabled, but silent

    await advance(PENDING_LABEL_DELAY_MS - 20);
    expect(label()).toBe('Save');

    await act(async () => { release(); });
    await advance(1000);

    // Never appeared, so it never had to disappear.
    expect(label()).toBe('Save');
    expect(btn().disabled).toBe(false);
  });

  it('an 80ms action — the brief\'s example — shows no label', async () => {
    let release!: () => void;
    const onRun = () => new Promise<void>((r) => { release = r; });
    render(<Harness onRun={onRun} />);
    await act(async () => { btn().click(); });
    await advance(80);
    await act(async () => { release(); });
    await advance(1000);
    expect(label()).toBe('Save');
  });

  it('DOES show the label once the delay is crossed', async () => {
    const onRun = () => new Promise(() => {});
    render(<Harness onRun={onRun} />);
    await act(async () => { btn().click(); });

    await advance(PENDING_LABEL_DELAY_MS - 1);
    expect(label()).toBe('Save');

    await advance(2);
    expect(label()).toBe('Saving…');
  });
});

describe('rule 3 — once shown, the label is held', () => {
  it('an action finishing just past the delay does not flash', async () => {
    // Without the minimum, this shows "Saving…" for 5 ms — the same
    // glitch the delay exists to prevent, merely relocated.
    let release!: () => void;
    const onRun = () => new Promise<void>((r) => { release = r; });
    render(<Harness onRun={onRun} />);

    await act(async () => { btn().click(); });
    await advance(PENDING_LABEL_DELAY_MS + 5);
    expect(label()).toBe('Saving…');

    await act(async () => { release(); });
    await advance(10);

    // Still up — being held.
    expect(label()).toBe('Saving…');

    await advance(PENDING_LABEL_MIN_MS);
    expect(label()).toBe('Save');
  });

  it('holds for the REMAINDER only, not a fresh full minimum', async () => {
    let release!: () => void;
    const onRun = () => new Promise<void>((r) => { release = r; });
    render(<Harness onRun={onRun} />);

    await act(async () => { btn().click(); });
    await advance(PENDING_LABEL_DELAY_MS);
    // Label has now been up for most of the minimum already.
    await advance(PENDING_LABEL_MIN_MS - 50);
    await act(async () => { release(); });

    await advance(60);   // just past the 50ms still owed
    expect(label()).toBe('Save');
  });

  it('a long action drops the label immediately once the minimum is already met', async () => {
    let release!: () => void;
    const onRun = () => new Promise<void>((r) => { release = r; });
    render(<Harness onRun={onRun} />);

    await act(async () => { btn().click(); });
    await advance(PENDING_LABEL_DELAY_MS + PENDING_LABEL_MIN_MS + 5_000);
    expect(label()).toBe('Saving…');

    await act(async () => { release(); });
    await advance(5);
    expect(label()).toBe('Save');
  });
});

describe('it works for BOTH pending patterns — the whole point of the hook', () => {
  it('mirrors an external flag (the useTransition shape)', async () => {
    render(<MirrorHarness />);
    expect(btn().disabled).toBe(false);

    await act(async () => { screen.getByTestId('on').click(); });
    expect(btn().disabled).toBe(true);        // immediate
    expect(label()).toBe('Save');            // still silent

    await advance(PENDING_LABEL_DELAY_MS + 5);
    expect(label()).toBe('Saving…');

    await act(async () => { screen.getByTestId('off').click(); });
    await advance(PENDING_LABEL_MIN_MS + 10);
    expect(btn().disabled).toBe(false);
    expect(label()).toBe('Save');
  });

  it('a fast external flag also never flashes', async () => {
    render(<MirrorHarness />);
    await act(async () => { screen.getByTestId('on').click(); });
    await advance(50);
    await act(async () => { screen.getByTestId('off').click(); });
    await advance(1000);
    expect(label()).toBe('Save');
  });

  it('re-entrancy: work restarting while the label is up does not blink it', async () => {
    render(<MirrorHarness />);
    await act(async () => { screen.getByTestId('on').click(); });
    await advance(PENDING_LABEL_DELAY_MS + 5);
    expect(label()).toBe('Saving…');

    // off then straight back on — a second submit landing on the tail of
    // the first. The label must stay up rather than flicker off and on.
    await act(async () => { screen.getByTestId('off').click(); });
    await act(async () => { screen.getByTestId('on').click(); });
    expect(label()).toBe('Saving…');

    await advance(PENDING_LABEL_MIN_MS + 100);
    expect(label()).toBe('Saving…');
  });
});

describe('unmounting mid-flight does not warn or throw', () => {
  it('a component that unmounts while pending drops its timers', async () => {
    // Real case: several call sites redirect on success via
    // window.location.assign and are torn down mid-flight. A timer firing
    // setState afterwards is a React warning and a leak.
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });

    const onRun = () => new Promise(() => {});
    render(<Harness onRun={onRun} />);
    await act(async () => { btn().click(); });
    cleanup();
    await advance(PENDING_LABEL_DELAY_MS + PENDING_LABEL_MIN_MS + 100);

    expect(errors).toEqual([]);
    spy.mockRestore();
  });
});
