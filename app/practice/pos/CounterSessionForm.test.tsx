import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CounterSessionForm from './CounterSessionForm';
import type { CounterSessionStage } from './actions';
import { VALID_SA_ID } from '@/lib/testing/saIdFixtures';

// ─── CounterSessionForm — first-timer hard-stop + confirm-at-counter ──────
//
// Exercises the till-side wiring added for Build C (expire triggers) and
// Build D (acknowledge), via the server actions injected as props (the
// same pattern as PracticeApprovalRow.test.tsx) rather than mocking
// modules. qrcode's toDataURL is mocked so the QR-render effect resolves
// deterministically without touching a real canvas in happy-dom.

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,fake') },
}));

const PROVIDERS = [{ memberId: 'mem1', name: 'Jane Doe' }];

function renderForm(overrides: {
  stageSequence?: CounterSessionStage[];
  expiresInMs?:   number;
} = {}) {
  const expiresInMs = overrides.expiresInMs ?? 120_000;
  const issueCounterSession = vi.fn(async () => ({
    error: null, token: 'tok-abc', expiresAt: new Date(Date.now() + expiresInMs).toISOString(), planId: 'plan-1',
  }));
  const expireCounterSession = vi.fn(async (_token: string, _opts?: { force?: boolean }) => ({ error: null }));
  const acknowledgeCounterSession = vi.fn(async (_token: string) => ({ error: null }));

  let stageCallIdx = 0;
  const stageSequence = overrides.stageSequence ?? ['created'];
  const getCounterSessionStage = vi.fn(async () => {
    const stage = stageSequence[Math.min(stageCallIdx, stageSequence.length - 1)];
    stageCallIdx += 1;
    return { error: null, stage };
  });

  render(
    <CounterSessionForm
      providers={PROVIDERS}
      maximumBillAmount={30000}
      issueCounterSession={issueCounterSession}
      expireCounterSession={expireCounterSession}
      getCounterSessionStage={getCounterSessionStage}
      acknowledgeCounterSession={acknowledgeCounterSession}
    />,
  );

  return { issueCounterSession, expireCounterSession, getCounterSessionStage, acknowledgeCounterSession };
}

// Issued under REAL timers — startTransition + waitFor's own polling
// don't interact reliably with fake timers, so the initial submit runs
// for real. Fake timers are switched on AFTERWARD, per test, only to
// deterministically drive the countdown/poll intervals.
async function issueASession() {
  fireEvent.change(screen.getByLabelText(/Bill amount/i), { target: { value: '1000' } });
  fireEvent.change(screen.getByTestId('pos-said-input'), { target: { value: VALID_SA_ID } });
  // fireEvent.submit rather than clicking the submit button — more
  // reliable than relying on happy-dom's click-triggers-submit wiring.
  fireEvent.submit(screen.getByTestId('pos-entry-form'));
  await waitFor(() => expect(screen.getByTestId('pos-qr-countdown')).toBeTruthy());
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CounterSessionForm — countdown reaching zero triggers a natural expire', () => {
  // Real timers throughout — the countdown's setInterval is registered
  // during issueASession() under real timers, and switching to fake
  // timers afterward does NOT retroactively take over an already-
  // scheduled real interval. Using an expiry that's already in the past
  // sidesteps that mismatch entirely: the very first real tick (within
  // ~1s) already sees remaining<=0 and fires the expire call — no
  // time-travel needed, and it's a realistic case in its own right (the
  // till re-rendering a session whose clock had already run out).
  it('calls expireCounterSession(token, {force:false}) exactly once once the clock has passed', async () => {
    const { expireCounterSession } = renderForm({ expiresInMs: -1000 });
    await issueASession();

    await waitFor(() => expect(expireCounterSession).toHaveBeenCalledWith('tok-abc', { force: false }));

    // Give the 1s interval a couple more real ticks — must not fire again
    // (guarded by expiredFiredRef).
    await new Promise((r) => setTimeout(r, 2200));
    const calls = expireCounterSession.mock.calls.filter((c) => c[0] === 'tok-abc');
    expect(calls.length).toBe(1);
  }, 10_000);
});

describe('CounterSessionForm — "Start next patient" abandonment', () => {
  it('force-expires a non-terminal session before resetting', async () => {
    const { expireCounterSession } = renderForm({ stageSequence: ['created'] });
    await issueASession();

    fireEvent.click(screen.getByRole('button', { name: /Start next patient/i }));

    expect(expireCounterSession).toHaveBeenCalledWith('tok-abc', { force: true });
    // Reset happened regardless — back to the entry form.
    expect(screen.queryByTestId('pos-qr-countdown')).toBeNull();
    expect(screen.getByRole('button', { name: /Generate QR/i })).toBeTruthy();
  });

  it('does NOT force-expire a session that already reached a terminal stage', async () => {
    const { expireCounterSession, getCounterSessionStage } = renderForm({ stageSequence: ['completed'] });
    await issueASession();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Let the poll pick up 'completed'.
    await vi.advanceTimersByTimeAsync(3500);
    await waitFor(() => expect(getCounterSessionStage).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('pos-acknowledge-button')).toBeTruthy());

    expireCounterSession.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Start next patient/i }));
    expect(expireCounterSession).not.toHaveBeenCalled();
  });
});

describe('CounterSessionForm — confirm-at-counter', () => {
  it('shows the Acknowledge button once the poll observes stage=completed, and stamps on click', async () => {
    const { acknowledgeCounterSession } = renderForm({ stageSequence: ['created', 'scanned', 'completed'] });
    await issueASession();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await vi.advanceTimersByTimeAsync(3500);
    await waitFor(() => expect(screen.getByTestId('pos-acknowledge-button')).toBeTruthy());

    fireEvent.click(screen.getByTestId('pos-acknowledge-button'));
    expect(acknowledgeCounterSession).toHaveBeenCalledWith('tok-abc');
    await waitFor(() => expect(screen.getByTestId('pos-acknowledged')).toBeTruthy());
  });

  it('"Start next patient" remains clickable even when the last session was never acknowledged', async () => {
    renderForm({ stageSequence: ['completed'] });
    await issueASession();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await vi.advanceTimersByTimeAsync(3500);
    await waitFor(() => expect(screen.getByTestId('pos-acknowledge-button')).toBeTruthy());

    // Never click Acknowledge — go straight to Start next patient.
    const nextBtn = screen.getByRole('button', { name: /Start next patient/i });
    expect(nextBtn).not.toBeDisabled();
    fireEvent.click(nextBtn);
    expect(screen.getByRole('button', { name: /Generate QR/i })).toBeTruthy();
  });
});
