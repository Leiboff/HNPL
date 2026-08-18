import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import PhoneField from './PhoneField';
import { maskPhone } from '@/lib/patient/maskContact';

// ─── Phone field — the old number stays authoritative until the new one
//                  verifies ────────────────────────────────────────────────
//
// This suite was rewritten when phone changes started requiring OTP
// re-verification. The previous version tested a save path that no longer
// exists: it asserted that a bare `updateProfile({ phone })` was called and
// that the display advanced to the just-saved value immediately. That
// behaviour WAS the bug — writing profiles.phone without verifying it left
// phone_verified_at describing the previous number, and dunning SMSed the
// unverified one.
//
// What carries over is the masking discipline. What replaces the save-path
// assertions is the state machine, and the invariant underneath it:
//
//   AT NO POINT does an unverified number become the displayed account
//   number, and abandoning at any point leaves the old one in place.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

const OLD = '+27820000000';
const NEW = '+27821234567';

type Bag = Record<string, unknown>;

/** The four server actions, each a resolved-ok mock unless overridden. */
function defaultActions(): Bag {
  return {
    startPhoneChange:      vi.fn().mockResolvedValue({ ok: true }),
    requestPhoneChangeOtp: vi.fn().mockResolvedValue({ ok: true }),
    verifyPhoneChangeOtp:  vi.fn().mockResolvedValue({ ok: true }),
    cancelPhoneChange:     vi.fn().mockResolvedValue({ ok: true }),
  };
}

/**
 * Render with sensible defaults. `actions` overrides individual action mocks;
 * any other key overrides a plain prop. Returns the resolved prop bag so a
 * test can assert on the exact mock the component received.
 */
function renderField(overrides: Bag & { actions?: Bag } = {}) {
  const { actions: actionOverrides, ...propOverrides } = overrides;
  const props: Bag = {
    current:    OLD,
    pending:    null,
    verifiedAt: '2026-03-01T10:00:00Z',
    ...defaultActions(),
    ...actionOverrides,
    ...propOverrides,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...render(<PhoneField {...(props as any)} />), props };
}

beforeEach(() => refresh.mockClear());
afterEach(() => cleanup());

describe('the old number stays authoritative', () => {
  it('shows the current number masked, with a Verified pill', () => {
    renderField();
    expect(screen.getByTestId('profile-phone-value').textContent).toContain(maskPhone(OLD));
    expect(screen.getByTestId('phone-state-verified')).toBeTruthy();
  });

  it('says "Not verified" when there is no verification timestamp', () => {
    // Honest for pre-gate accounts, whose phone_verified_at is NULL by design
    // ("we never retroactively claim a phone we did not verify" — 0052).
    renderField({ verifiedAt: null });
    expect(screen.getByTestId('phone-state-unverified')).toBeTruthy();
  });

  it('THE INVARIANT: entering a new number does not display it as the account number', async () => {
    // The regression that would reintroduce the bug. Until the code is
    // entered, the account number on screen must still be the old one.
    const { props } = renderField();
    fireEvent.click(screen.getByTestId('profile-phone-edit'));
    fireEvent.change(screen.getByTestId('profile-phone-input'), { target: { value: '0821234567' } });
    fireEvent.click(screen.getByTestId('profile-phone-save'));

    await waitFor(() => expect(props.startPhoneChange).toHaveBeenCalledWith('0821234567'));
    // Now in the verifying state — and it says the OLD number is still in use.
    const banner = await screen.findByTestId('profile-phone-verifying');
    expect(banner.textContent).toContain(maskPhone(OLD));
    expect(banner.textContent).toMatch(/keep using/i);
  });

  it('a pending change from a previous visit is VISIBLE on arrival, not silent', async () => {
    // "A pending change should be visible" — the field opens straight into the
    // verifying state rather than looking idle with a hidden staged number.
    renderField({ pending: NEW });
    const banner = await screen.findByTestId('profile-phone-verifying');
    expect(banner.textContent).toContain(maskPhone(NEW));
    expect(screen.queryByTestId('profile-phone-edit')).toBeNull();
  });
});

describe('abandoning leaves the account on the old number', () => {
  it('Cancel while editing never stages anything', () => {
    const { props } = renderField();
    fireEvent.click(screen.getByTestId('profile-phone-edit'));
    fireEvent.change(screen.getByTestId('profile-phone-input'), { target: { value: '0821234567' } });
    fireEvent.click(screen.getByText('Cancel'));

    expect(props.startPhoneChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('profile-phone-value').textContent).toContain(maskPhone(OLD));
  });

  it('"Change number" during OTP clears the staged value and restores the old number', async () => {
    const { props } = renderField({ pending: NEW });
    await screen.findByTestId('profile-phone-verifying');

    fireEvent.click(screen.getByText(/Change number/i));

    await waitFor(() => expect(props.cancelPhoneChange).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('profile-phone-value').textContent).toContain(maskPhone(OLD)),
    );
  });
});

describe('validation still blocks a bad number before anything is staged', () => {
  it('rejects letters inline and does NOT call the action', async () => {
    const { props } = renderField();
    fireEvent.click(screen.getByTestId('profile-phone-edit'));
    fireEvent.change(screen.getByTestId('profile-phone-input'), { target: { value: 'abcxyz!!' } });
    fireEvent.click(screen.getByTestId('profile-phone-save'));

    await waitFor(() => expect(screen.getByText(/valid South African mobile/i)).toBeTruthy());
    expect(props.startPhoneChange).not.toHaveBeenCalled();
  });

  it('rejects a landline the same way', async () => {
    const { props } = renderField();
    fireEvent.click(screen.getByTestId('profile-phone-edit'));
    fireEvent.change(screen.getByTestId('profile-phone-input'), { target: { value: '0211234567' } });
    fireEvent.click(screen.getByTestId('profile-phone-save'));

    await waitFor(() => expect(screen.getByText(/valid South African mobile/i)).toBeTruthy());
    expect(props.startPhoneChange).not.toHaveBeenCalled();
  });

  it('surfaces a server refusal without staging anything locally', async () => {
    renderField({
      actions: { startPhoneChange: vi.fn().mockResolvedValue({ ok: false, code: 'same_number' }) },
    });
    fireEvent.click(screen.getByTestId('profile-phone-edit'));
    fireEvent.change(screen.getByTestId('profile-phone-input'), { target: { value: '0820000000' } });
    fireEvent.click(screen.getByTestId('profile-phone-save'));

    await waitFor(() => expect(screen.getByText(/already your number/i)).toBeTruthy());
    // Crucially NOT in the verifying state: a refused start stages nothing, so
    // there is no pending change and the account number is untouched.
    expect(screen.queryByTestId('profile-phone-verifying')).toBeNull();
    // Still on the edit form, so the patient can correct the number.
    expect(screen.getByTestId('profile-phone-input')).toBeTruthy();
  });
});

describe('the shared OTP step does the sending, exactly once', () => {
  it('auto-sends on mount via requestPhoneChangeOtp — and the field does not send too', async () => {
    // Sending from both the field and the step would burn two of the five
    // codes a patient gets per day for a single change.
    const { props } = renderField({ pending: NEW });
    await waitFor(() => expect(props.requestPhoneChangeOtp).toHaveBeenCalledTimes(1));
  });

  it('startPhoneChange is never what sends the SMS', async () => {
    const { props } = renderField();
    fireEvent.click(screen.getByTestId('profile-phone-edit'));
    fireEvent.change(screen.getByTestId('profile-phone-input'), { target: { value: '0821234567' } });
    fireEvent.click(screen.getByTestId('profile-phone-save'));

    await waitFor(() => expect(props.startPhoneChange).toHaveBeenCalledTimes(1));
    // Exactly one send, and it came from the step's mount.
    await waitFor(() => expect(props.requestPhoneChangeOtp).toHaveBeenCalledTimes(1));
  });

  it('promotes and refreshes once the code verifies', async () => {
    const { props } = renderField({ pending: NEW });
    await screen.findByTestId('profile-phone-verifying');

    const input = screen
      .getAllByLabelText('6-digit verification code')
      .find((el): el is HTMLInputElement => el.tagName === 'INPUT')!;
    fireEvent.change(input, { target: { value: '123456' } });

    await waitFor(() => expect(props.verifyPhoneChangeOtp).toHaveBeenCalledWith('123456'));
    // Server has promoted; the field returns to idle and re-reads from the
    // server rather than guessing the new value locally.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Number updated and verified.')).toBeTruthy());
  });
});

describe('masking', () => {
  it('the raw current number is never in the DOM', () => {
    const { container } = renderField();
    expect(container.textContent).not.toContain(OLD);
    expect(container.textContent).toContain(maskPhone(OLD));
  });

  it('the staged number is masked too, in the pending banner', async () => {
    const { container } = renderField({ pending: NEW });
    await screen.findByTestId('profile-phone-verifying');
    expect(container.textContent).not.toContain(NEW);
    expect(container.textContent).toContain(maskPhone(NEW));
  });

  it('EDITABLE: the input is empty and accepts a new number', () => {
    // Masked-but-editable, in the form this flow needs. The old field
    // pre-filled the current number for in-place correction; here the task is
    // "what is your NEW number?", so pre-filling a value that must be
    // replaced would be friction — and it would put the raw number back on
    // screen, undoing the masking.
    renderField();
    fireEvent.click(screen.getByTestId('profile-phone-edit'));
    const input = screen.getByTestId('profile-phone-input') as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '0821234567' } });
    expect(input.value).toBe('0821234567');
  });

  it('shows an empty state, not a dash, when there is no number at all', () => {
    renderField({ current: null, verifiedAt: null });
    expect(screen.getByTestId('empty-state')).toBeTruthy();
    expect(screen.getByTestId('profile-phone-value').textContent).toContain('No mobile number');
    // And the affordance reads "Add", not "Change".
    expect(screen.getByTestId('profile-phone-edit').textContent).toContain('Add');
  });
});
