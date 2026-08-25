import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import IdentityStepClient from './IdentityStepClient';
import { VALID_SA_ID } from '@/lib/testing/saIdFixtures';

// ─── Identity step client — SA ID + consent ONLY ───────────────────────
//
// The salary form that used to share this component now lives in
// app/onboarding/salary/SalaryStepClient.tsx, as its own onboarding
// step. Its tests moved with it.
//
// SA ID capture stays here: the registry-photo-first architecture needs
// the ID typed locally before any Didit session exists. Submitting calls
// submitIdentityForVerification — the server decides approve vs
// decline vs review.
//
// fireEvent.submit(form) rather than clicking submit — same convention
// as CounterSessionForm.test.tsx: happy-dom does not reliably run the
// implicit-submission algorithm for a plain button click.

const { submitIdentityForVerification, refreshOnboardingState } = vi.hoisted(() => ({
  submitIdentityForVerification: vi.fn(),
  refreshOnboardingState:       vi.fn(),
}));
vi.mock('@/lib/onboarding/actions', () => ({ submitIdentityForVerification, refreshOnboardingState }));

beforeEach(() => {
  submitIdentityForVerification.mockReset();
  submitIdentityForVerification.mockResolvedValue({ error: null, outcome: 'redirect', url: 'https://verify.didit.me/session/abc123' });
  refreshOnboardingState.mockReset();
  refreshOnboardingState.mockResolvedValue({ error: null, nextPath: '/onboarding/identity' });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, href: '' },
  });
});

function baseProps() {
  return {
    identityVerificationStatus: null,
    identityVerificationReason: null,
    returningFromDidit: false,
  };
}

function submitVerify() {
  fireEvent.submit(screen.getByTestId('onboarding-identity-verify-button').closest('form')!);
}

describe('IdentityStepClient — identity verification (SA ID + consent)', () => {
  it('blocks submit with a generic message for an invalid SA ID, no server call', async () => {
    render(<IdentityStepClient {...baseProps()} />);
    fireEvent.change(screen.getByTestId('onboarding-sa-id'), { target: { value: '0000000000000' } });
    fireEvent.click(screen.getByTestId('onboarding-dha-consent'));
    submitVerify();

    expect(await screen.findByText('Please enter a valid SA ID number.')).toBeTruthy();
    expect(submitIdentityForVerification).not.toHaveBeenCalled();
  });

  it('blocks submit when consent is not given, no server call', async () => {
    render(<IdentityStepClient {...baseProps()} />);
    fireEvent.change(screen.getByTestId('onboarding-sa-id'), { target: { value: VALID_SA_ID } });
    submitVerify();

    expect(await screen.findByText('Please provide consent to continue.')).toBeTruthy();
    expect(submitIdentityForVerification).not.toHaveBeenCalled();
  });

  it('submits SA ID + consent together once both are valid', async () => {
    render(<IdentityStepClient {...baseProps()} />);
    fireEvent.change(screen.getByTestId('onboarding-sa-id'), { target: { value: VALID_SA_ID } });
    fireEvent.click(screen.getByTestId('onboarding-dha-consent'));
    submitVerify();

    await waitFor(() => expect(submitIdentityForVerification).toHaveBeenCalledWith({
      saIdNumber: VALID_SA_ID,
      consent:    true,
    }));
  });

  it('redirects to the Didit hosted URL on outcome:redirect', async () => {
    render(<IdentityStepClient {...baseProps()} />);
    fireEvent.change(screen.getByTestId('onboarding-sa-id'), { target: { value: VALID_SA_ID } });
    fireEvent.click(screen.getByTestId('onboarding-dha-consent'));
    submitVerify();

    await waitFor(() => expect(window.location.href).toBe('https://verify.didit.me/session/abc123'));
  });

  it('reloads the page on outcome:review (no url to redirect to)', async () => {
    submitIdentityForVerification.mockResolvedValue({ error: null, outcome: 'review' });
    render(<IdentityStepClient {...baseProps()} />);
    fireEvent.change(screen.getByTestId('onboarding-sa-id'), { target: { value: VALID_SA_ID } });
    fireEvent.click(screen.getByTestId('onboarding-dha-consent'));
    submitVerify();

    await waitFor(() => expect(window.location.href).toBe('/onboarding/identity'));
  });

  it('shows an inline error and does not navigate on a synchronous decline', async () => {
    submitIdentityForVerification.mockResolvedValue({ error: 'We couldn\'t verify your identity. Please try again.' });
    render(<IdentityStepClient {...baseProps()} />);
    fireEvent.change(screen.getByTestId('onboarding-sa-id'), { target: { value: VALID_SA_ID } });
    fireEvent.click(screen.getByTestId('onboarding-dha-consent'));
    submitVerify();

    expect(await screen.findByText('We couldn\'t verify your identity. Please try again.')).toBeTruthy();
    expect(window.location.href).toBe('');
  });

  it('shows a declined message and offers a retry when the last session was declined', () => {
    render(<IdentityStepClient {...baseProps()} identityVerificationStatus="declined" />);
    expect(screen.getByText("We couldn't verify your identity. Please try again.")).toBeTruthy();
    expect(screen.getByTestId('onboarding-identity-verify-button').textContent).toBe('Try again');
  });

  it('hides the SA ID form once approved', () => {
    render(<IdentityStepClient {...baseProps()} identityVerificationStatus="approved" />);
    expect(screen.getByTestId('onboarding-identity-verified')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-identity-verify-button')).toBeNull();
    expect(screen.queryByTestId('onboarding-sa-id')).toBeNull();
  });

  it('shows the account-already-exists guidance (and no form) on a duplicate-ID decline', () => {
    render(<IdentityStepClient {...baseProps()} identityVerificationStatus="declined" identityVerificationReason="id_already_registered" />);
    expect(screen.getByText(/An account already exists for this ID number/)).toBeTruthy();
    expect(screen.getByText(/Forgot password/)).toBeTruthy();
    expect(screen.queryByTestId('onboarding-identity-verify-button')).toBeNull();
    expect(screen.queryByTestId('onboarding-sa-id')).toBeNull();
  });

  it('shows contact-support copy (and no form) on a deceased decline — not user-actionable', () => {
    render(<IdentityStepClient {...baseProps()} identityVerificationStatus="declined" identityVerificationReason="dha_deceased" />);
    expect(screen.getByText(/contact support/)).toBeTruthy();
    expect(screen.queryByTestId('onboarding-identity-verify-button')).toBeNull();
  });

  it('shows contact-support copy (and no form) on an id_blocked decline — not user-actionable', () => {
    render(<IdentityStepClient {...baseProps()} identityVerificationStatus="declined" identityVerificationReason="dha_id_blocked" />);
    expect(screen.getByText(/contact support/)).toBeTruthy();
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

describe('separation from salary', () => {
  it('renders no salary day picker and no income field', () => {
    // Pins the split. These belong to /onboarding/salary now; if they
    // reappear here, one screen is again asking for a government ID,
    // biometric consent, a pay date and an income figure at once.
    render(<IdentityStepClient {...baseProps()} />);
    expect(screen.queryByTestId('onboarding-salary-amount')).toBeNull();
    expect(screen.queryByTestId('onboarding-identity-submit')).toBeNull();
  });

  it('does not describe scanning an ID document', () => {
    // The old copy said "We'll scan your SA ID and take a quick selfie".
    // There is no document scan on this path — the reference photo comes
    // from the identity registry, not a photograph of a card. Copy that
    // misdescribes what happens to a person's biometrics is a compliance
    // problem, not just a wording one.
    const { container } = render(<IdentityStepClient {...baseProps()} />);
    expect(container.textContent).not.toMatch(/scan your SA ID/i);
  });

  it('does not name a specific government department in the consent copy', () => {
    // With IDENTITY_PHOTO_PROVIDER=datanamix the photo comes from a
    // credit bureau's copy of Home Affairs data — a different controller.
    // Naming Home Affairs would be an inaccurate POPIA disclosure.
    // NOTE: the replacement wording is still pending legal review.
    const { container } = render(<IdentityStepClient {...baseProps()} />);
    expect(container.textContent).not.toMatch(/Department of\s+Home Affairs/i);
  });
});
