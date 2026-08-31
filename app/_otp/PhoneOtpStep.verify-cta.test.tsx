import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PhoneOtpStep, { type PhoneOtpVerifyResult } from './PhoneOtpStep';

// ─── The two OTP screens must behave the same ──────────────────────────
//
// Reported from the field: the email verification screen has a "Verify
// email" button that the sixth digit presses for you, and the phone one
// had no button at all. Same six cells, silently doing something
// different — and no way back for anyone whose autofill filled the field
// without firing onComplete.
//
// The auto-submit on the sixth digit is unchanged and is still the normal
// path. These tests cover both routes into the verify call, and the states
// the button has to hold while the hand-off happens.

const requestCode = vi.fn(async () => ({ ok: true as const }));

// Typed against the component's own contract, so a failing-verify mock is
// not narrowed to the success shape by the default parameter.
type VerifyFn = () => Promise<PhoneOtpVerifyResult>;

function setup(
  verifyCode: ReturnType<typeof vi.fn<VerifyFn>> = vi.fn<VerifyFn>(async () => ({ ok: true })),
  onVerified = vi.fn(),
) {
  render(
    <PhoneOtpStep
      phoneDisplay="+27 82 123 4567"
      requestCode={requestCode}
      verifyCode={verifyCode}
      onVerified={onVerified}
    />,
  );
  return { verifyCode, onVerified };
}

/**
 * The single real input behind the six presentational cells. Found by
 * ROLE, not by label: OtpInput puts the same aria-label on the wrapping
 * role="group" and on the input, so getByLabelText matches both.
 */
const otpField = () => screen.getByRole('textbox');
const cta      = () => screen.getByTestId('phone-otp-verify') as HTMLButtonElement;

beforeEach(() => {
  requestCode.mockClear();
});

describe('the phone screen has a verify button, like the email one', () => {
  it('renders it, labelled for a cellphone', () => {
    setup();
    expect(cta().textContent).toMatch(/verify cellphone/i);
  });

  it('is disabled until all six digits are in', () => {
    setup();
    expect(cta().disabled).toBe(true);

    fireEvent.change(otpField(), { target: { value: '12345' } });
    expect(cta().disabled).toBe(true);

    fireEvent.change(otpField(), { target: { value: '123456' } });
    // onComplete already fired on the sixth digit, so by now the button is
    // in its verifying/verified state — either way it must not be sitting
    // there enabled and unpressed.
    expect(cta().textContent).not.toMatch(/verify cellphone/i);
  });

  it('the sixth digit still submits on its own — the button did not replace that', async () => {
    const { verifyCode } = setup();
    fireEvent.change(otpField(), { target: { value: '482165' } });
    await waitFor(() => expect(verifyCode).toHaveBeenCalledWith('482165'));
  });

  it('the button is a second route to the SAME call, for a code that arrived without onComplete', async () => {
    // A paste or autofill that sets the value without firing onComplete
    // used to leave the patient stuck with a full field and nothing to
    // press. Simulate that by clearing the auto-submit's effect and
    // pressing the button.
    const verifyCode = vi.fn<VerifyFn>(async () => ({ ok: false, code: 'wrong_code' }));
    setup(verifyCode);

    fireEvent.change(otpField(), { target: { value: '111111' } });
    await waitFor(() => expect(verifyCode).toHaveBeenCalledTimes(1));

    // Wrong code: the field keeps its digits and the button is live again.
    await waitFor(() => expect(cta().disabled).toBe(false));
    fireEvent.click(cta());
    await waitFor(() => expect(verifyCode).toHaveBeenCalledTimes(2));
  });

  it('holds "Verified ✓" through the hand-off rather than springing back', async () => {
    // onVerified navigates away; the button must not flick back to
    // "Verify cellphone" while that happens.
    const { onVerified } = setup();
    fireEvent.change(otpField(), { target: { value: '482165' } });

    await waitFor(() => expect(onVerified).toHaveBeenCalled());
    await waitFor(() => expect(cta().textContent).toMatch(/verified/i));
    expect(cta().disabled).toBe(true);
  });

  it('a failed verify leaves the code and the button usable', async () => {
    const verifyCode = vi.fn<VerifyFn>(async () => ({ ok: false, code: 'wrong_code' }));
    setup(verifyCode);

    fireEvent.change(otpField(), { target: { value: '000000' } });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/didn’t match/i));
    expect(cta().disabled).toBe(false);
    expect(cta().textContent).toMatch(/verify cellphone/i);
  });

  it('an expired code clears the field, so the button goes back to disabled', async () => {
    const verifyCode = vi.fn<VerifyFn>(async () => ({ ok: false, code: 'expired' }));
    setup(verifyCode);

    fireEvent.change(otpField(), { target: { value: '000000' } });

    await waitFor(() => expect(cta().disabled).toBe(true));
    expect(screen.getByRole('alert').textContent).toMatch(/expired/i);
  });
});

describe('when SMS is not configured there is nothing to verify against', () => {
  it('the button stays disabled', async () => {
    const requestUnavailable = vi.fn(async () => ({ ok: false as const, code: 'sms_not_configured' }));
    render(
      <PhoneOtpStep
        phoneDisplay="+27 82 123 4567"
        requestCode={requestUnavailable}
        verifyCode={vi.fn(async () => ({ ok: true as const }))}
        onVerified={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/isn’t set up/i));
    expect(cta().disabled).toBe(true);
  });
});
