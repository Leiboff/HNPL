import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const verifyOtp = vi.fn();
const resendConfirmation = vi.fn(async () => ({ ok: true as const }));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { verifyOtp: (args: unknown) => verifyOtp(args) },
  }),
}));

vi.mock('@/app/auth/resend/actions', () => ({
  resendConfirmation: (email: string) => resendConfirmation(email),
}));

// Hard-navigation stub. happy-dom won't navigate by setting window.location.href;
// we replace the assignment with a spy to capture the target.
const navTo = vi.fn();
beforeEach(() => {
  verifyOtp.mockReset();
  resendConfirmation.mockClear();
  navTo.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      href: '',
      get assign() { return navTo; },
      set href(v: string) { navTo(v); },
    },
  });
});

// Import the component AFTER mocks are registered.
import VerifyEmailForm from './VerifyEmailForm';

function fillCode(code: string) {
  for (let i = 0; i < code.length; i++) {
    const cell = document.getElementById(`otp-${i}`) as HTMLInputElement;
    fireEvent.change(cell, { target: { value: code[i] } });
  }
}

// ─── verifyOtp call shape ────────────────────────────────────────────────────

describe('VerifyEmailForm — verifyOtp call shape', () => {
  it('calls verifyOtp with the exact { email, token, type: "email" } payload on submit', async () => {
    verifyOtp.mockResolvedValueOnce({ error: null });
    render(<VerifyEmailForm email="jane@example.com" next="/patient" />);
    fillCode('123456');
    await waitFor(() => expect(verifyOtp).toHaveBeenCalled());
    expect(verifyOtp).toHaveBeenCalledWith({
      email: 'jane@example.com',
      token: '123456',
      type:  'email',
    });
  });

  it('hard-navigates to `next` on success', async () => {
    verifyOtp.mockResolvedValueOnce({ error: null });
    render(<VerifyEmailForm email="jane@example.com" next="/practice" />);
    fillCode('123456');
    await waitFor(() => expect(navTo).toHaveBeenCalledWith('/practice'));
  });
});

// ─── Error classification ───────────────────────────────────────────────────

describe('VerifyEmailForm — error classification', () => {
  // The classifier reads error.code (the structured field) — NOT
  // error.message. GoTrue returns the SAME message for expired AND
  // wrong codes ("Token has expired or is invalid"), so message-based
  // classification mis-routed wrong codes to the expired branch.

  it('shows "expired" copy when Supabase reports code=otp_expired', async () => {
    verifyOtp.mockResolvedValueOnce({
      error: { code: 'otp_expired', message: 'Token has expired or is invalid', status: 403 },
    });
    render(<VerifyEmailForm email="jane@example.com" next="/patient" />);
    fillCode('123456');
    await screen.findByTestId('otp-error');
    expect(screen.getByTestId('otp-error').textContent).toMatch(/expired/i);
  });

  it('shows "incorrect" copy for a wrong-but-current code (no otp_expired code)', async () => {
    // GoTrue regression: the message says "expired or is invalid" even
    // for a typo'd-but-not-yet-expired code. Without code='otp_expired'
    // we must NOT route this to the expired branch.
    verifyOtp.mockResolvedValueOnce({
      error: { message: 'Token has expired or is invalid', status: 403 },
    });
    render(<VerifyEmailForm email="jane@example.com" next="/patient" />);
    fillCode('000000');
    await screen.findByTestId('otp-error');
    const text = screen.getByTestId('otp-error').textContent ?? '';
    expect(text).toMatch(/incorrect/i);
    expect(text).not.toMatch(/expired/i);
  });

  it('shows "rate limited" copy when Supabase reports a *_rate_limit code', async () => {
    verifyOtp.mockResolvedValueOnce({
      error: { code: 'over_request_rate_limit', message: 'rate limit exceeded', status: 429 },
    });
    render(<VerifyEmailForm email="jane@example.com" next="/patient" />);
    fillCode('111111');
    await screen.findByTestId('otp-error');
    expect(screen.getByTestId('otp-error').textContent).toMatch(/too many/i);
  });

  it('shows "rate limited" copy on HTTP 429 even when code is absent', async () => {
    verifyOtp.mockResolvedValueOnce({
      error: { message: 'too many requests', status: 429 },
    });
    render(<VerifyEmailForm email="jane@example.com" next="/patient" />);
    fillCode('222222');
    await screen.findByTestId('otp-error');
    expect(screen.getByTestId('otp-error').textContent).toMatch(/too many/i);
  });

  it('defaults to "incorrect" for any other failure shape', async () => {
    verifyOtp.mockResolvedValueOnce({ error: { message: 'Token mismatch' } });
    render(<VerifyEmailForm email="jane@example.com" next="/patient" />);
    fillCode('333333');
    await screen.findByTestId('otp-error');
    expect(screen.getByTestId('otp-error').textContent).toMatch(/incorrect/i);
  });

  it('does not hard-navigate when verifyOtp returns an error', async () => {
    verifyOtp.mockResolvedValueOnce({ error: { code: 'invalid', message: 'Invalid OTP' } });
    render(<VerifyEmailForm email="jane@example.com" next="/patient" />);
    fillCode('000000');
    await screen.findByTestId('otp-error');
    expect(navTo).not.toHaveBeenCalled();
  });
});

// ─── Resend + cooldown ──────────────────────────────────────────────────────

describe('VerifyEmailForm — resend + cooldown', () => {
  it('calls resendConfirmation with the email when clicked', async () => {
    render(<VerifyEmailForm email="jane@example.com" next="/patient" />);
    fireEvent.click(screen.getByTestId('otp-resend'));
    await waitFor(() => expect(resendConfirmation).toHaveBeenCalledWith('jane@example.com'));
  });

  it('disables the resend button during cooldown and shows the countdown', async () => {
    vi.useFakeTimers();
    try {
      render(<VerifyEmailForm email="jane@example.com" next="/patient" />);
      const btn = screen.getByTestId('otp-resend') as HTMLButtonElement;

      await act(async () => { fireEvent.click(btn); });
      // Allow the resend promise to resolve.
      await act(async () => { await Promise.resolve(); });

      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toMatch(/Resend in \d+s/);

      // Tick the countdown forward.
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(btn.textContent).toMatch(/Resend in \d+s/);
    } finally {
      vi.useRealTimers();
    }
  });
});
