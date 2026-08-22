import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import IdentityStepClient from './IdentityStepClient';

// ─── Identity step client — salary form + Didit verification trigger ───
//
// SA ID capture moved out of this component entirely (it's a Didit-hosted
// session now — see startIdentityVerification). This file covers the two
// pieces that remain client-side: the salary form, and the button that
// kicks off + redirects to a Didit session. The webhook's decision logic
// is covered by app/api/verification/didit/webhook/route.test.ts, not here.
//
// fireEvent.submit(form) rather than clicking submit — same convention as
// CounterSessionForm.test.tsx: happy-dom doesn't reliably run implicit
// form submission on a plain button click.

const { saveSalaryDetails, startIdentityVerification, refreshOnboardingState } = vi.hoisted(() => ({
  saveSalaryDetails:         vi.fn(),
  startIdentityVerification: vi.fn(),
  refreshOnboardingState:    vi.fn(),
}));
vi.mock('@/lib/onboarding/actions', () => ({ saveSalaryDetails, startIdentityVerification, refreshOnboardingState }));

beforeEach(() => {
  saveSalaryDetails.mockReset();
  saveSalaryDetails.mockResolvedValue({ error: null, nextPath: '/onboarding/identity' });
  startIdentityVerification.mockReset();
  startIdentityVerification.mockResolvedValue({ error: null, url: 'https://verify.didit.me/session/abc123' });
  refreshOnboardingState.mockReset();
  refreshOnboardingState.mockResolvedValue({ error: null, nextPath: '/onboarding/identity' });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, href: '' },
  });
});

function baseProps() {
  return {
    salaryDay: null,
    salaryAmount: null,
    identityVerificationStatus: null,
    identityVerificationReason: null,
    returningFromDidit: false,
  };
}

function submitSalary() {
  fireEvent.submit(screen.getByTestId('onboarding-identity-submit').closest('form')!);
}

describe('IdentityStepClient — salary form', () => {
  it('blocks submit with a generic message when salary day is missing', async () => {
    render(<IdentityStepClient {...baseProps()} />);
    fireEvent.change(screen.getByTestId('onboarding-salary-amount'), { target: { value: '15000' } });
    submitSalary();

    expect(await screen.findByText('Please choose when your salary is paid.')).toBeTruthy();
    expect(saveSalaryDetails).not.toHaveBeenCalled();
  });

  it('blocks submit for a zero/negative amount', async () => {
    render(<IdentityStepClient {...baseProps()} />);
    fireEvent.click(screen.getByRole('radio', { name: /1st/ }));
    fireEvent.change(screen.getByTestId('onboarding-salary-amount'), { target: { value: '0' } });
    submitSalary();

    expect(await screen.findByText('Please enter how much you earn a month.')).toBeTruthy();
    expect(saveSalaryDetails).not.toHaveBeenCalled();
  });

  it('submits day + amount once both are valid', async () => {
    render(<IdentityStepClient {...baseProps()} />);
    fireEvent.click(screen.getByRole('radio', { name: /1st/ }));
    fireEvent.change(screen.getByTestId('onboarding-salary-amount'), { target: { value: '15000' } });
    submitSalary();

    await waitFor(() => expect(saveSalaryDetails).toHaveBeenCalledWith({
      salaryDay:    1,
      salaryAmount: 15000,
    }));
  });

  it('navigates away once the server says the step moved on', async () => {
    saveSalaryDetails.mockResolvedValue({ error: null, nextPath: '/onboarding/credit-check' });
    render(<IdentityStepClient {...baseProps()} />);
    fireEvent.click(screen.getByRole('radio', { name: /1st/ }));
    fireEvent.change(screen.getByTestId('onboarding-salary-amount'), { target: { value: '15000' } });
    submitSalary();

    await waitFor(() => expect(window.location.href).toBe('/onboarding/credit-check'));
  });

  it('stays on the page (no navigation) when identity is still incomplete', async () => {
    render(<IdentityStepClient {...baseProps()} />);
    fireEvent.click(screen.getByRole('radio', { name: /1st/ }));
    fireEvent.change(screen.getByTestId('onboarding-salary-amount'), { target: { value: '15000' } });
    submitSalary();

    await waitFor(() => expect(saveSalaryDetails).toHaveBeenCalled());
    expect(window.location.href).toBe('');
  });
});

describe('IdentityStepClient — Didit verification', () => {
  it('starts a session and redirects to Didit\'s hosted URL', async () => {
    render(<IdentityStepClient {...baseProps()} />);
    fireEvent.click(screen.getByTestId('onboarding-identity-verify-button'));

    await waitFor(() => expect(startIdentityVerification).toHaveBeenCalled());
    await waitFor(() => expect(window.location.href).toBe('https://verify.didit.me/session/abc123'));
  });

  it('shows an inline error and does not navigate when session creation fails', async () => {
    startIdentityVerification.mockResolvedValue({ error: 'Could not start identity verification. Please try again.' });
    render(<IdentityStepClient {...baseProps()} />);
    fireEvent.click(screen.getByTestId('onboarding-identity-verify-button'));

    expect(await screen.findByText('Could not start identity verification. Please try again.')).toBeTruthy();
    expect(window.location.href).toBe('');
  });

  it('shows a declined message and offers a retry when the last session was declined', () => {
    render(<IdentityStepClient {...baseProps()} identityVerificationStatus="declined" />);
    expect(screen.getByText("We couldn't verify your identity. Please try again.")).toBeTruthy();
    expect(screen.getByTestId('onboarding-identity-verify-button').textContent).toBe('Try again');
  });

  it('hides the verify button once approved', () => {
    render(<IdentityStepClient {...baseProps()} identityVerificationStatus="approved" />);
    expect(screen.getByTestId('onboarding-identity-verified')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-identity-verify-button')).toBeNull();
  });

  it('shows the account-already-exists guidance (and no retry button) on a duplicate-ID decline', () => {
    render(<IdentityStepClient {...baseProps()} identityVerificationStatus="declined" identityVerificationReason="id_already_registered" />);
    expect(screen.getByText(/An account already exists for this ID number/)).toBeTruthy();
    expect(screen.getByText(/Forgot password/)).toBeTruthy();
    expect(screen.queryByTestId('onboarding-identity-verify-button')).toBeNull();
  });
});

describe('IdentityStepClient — returning from Didit', () => {
  it('polls refreshOnboardingState and navigates once the step advances', async () => {
    vi.useFakeTimers();
    refreshOnboardingState.mockResolvedValueOnce({ error: null, nextPath: '/onboarding/identity' });
    refreshOnboardingState.mockResolvedValueOnce({ error: null, nextPath: '/onboarding/credit-check' });

    render(<IdentityStepClient {...baseProps()} returningFromDidit />);
    expect(screen.getByTestId('onboarding-identity-polling')).toBeTruthy();

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(window.location.href).toBe('/onboarding/credit-check');
    vi.useRealTimers();
  });
});
