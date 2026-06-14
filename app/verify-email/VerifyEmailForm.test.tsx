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

describe('VerifyEmailForm — error messages', () => {
  it('shows "expired" copy when Supabase says the token has expired', async () => {
    verifyOtp.mockResolvedValueOnce({ error: { message: 'OTP has expired' } });
    render(<VerifyEmailForm email="jane@example.com" next="/patient" />);
    fillCode('123456');
    await screen.findByTestId('otp-error');
    expect(screen.getByTestId('otp-error').textContent).toMatch(/expired/i);
  });

  it('shows "rate limited" copy on too-many-attempts response', async () => {
    verifyOtp.mockResolvedValueOnce({ error: { message: 'Too many requests' } });
    render(<VerifyEmailForm email="jane@example.com" next="/patient" />);
    fillCode('111111');
    await screen.findByTestId('otp-error');
    expect(screen.getByTestId('otp-error').textContent).toMatch(/too many/i);
  });

  it('shows generic "wrong code" copy on any other failure', async () => {
    verifyOtp.mockResolvedValueOnce({ error: { message: 'Token mismatch' } });
    render(<VerifyEmailForm email="jane@example.com" next="/patient" />);
    fillCode('000000');
    await screen.findByTestId('otp-error');
    expect(screen.getByTestId('otp-error').textContent).toMatch(/doesn.t match/i);
  });

  it('does not hard-navigate when verifyOtp returns an error', async () => {
    verifyOtp.mockResolvedValueOnce({ error: { message: 'Invalid OTP' } });
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
