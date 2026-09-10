import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PhoneStepClient from './PhoneStepClient';

const { setPhoneForOnboarding, recordClientRecoveryFailure } = vi.hoisted(() => ({
  setPhoneForOnboarding: vi.fn(), recordClientRecoveryFailure: vi.fn(),
}));
vi.mock('@/lib/onboarding/actions', () => ({ setPhoneForOnboarding, recordClientRecoveryFailure }));
vi.mock('@/app/(auth)/verify-phone/actions', () => ({ requestPhoneOtpForUser: vi.fn(), verifyPhoneOtpForUser: vi.fn() }));
vi.mock('@/app/_otp/PhoneOtpStep', () => ({ default: () => <div>OTP</div> }));

beforeEach(() => { setPhoneForOnboarding.mockReset(); recordClientRecoveryFailure.mockReset(); });

it('recovers from a rejected phone action and offers a safe retry', async () => {
  setPhoneForOnboarding.mockRejectedValue(new Error('database secret detail'));
  render(<PhoneStepClient existingPhone={null} nextPath="/onboarding/salary" />);
  fireEvent.change(screen.getByRole('textbox', { name: /cell number/i }), { target: { value: '82 123 4567' } });
  fireEvent.submit(screen.getByRole('textbox', { name: /cell number/i }).closest('form')!);
  expect(screen.getByRole('button')).toHaveTextContent('Saving…');
  expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't save your number. Please try again.");
  expect(screen.getByRole('button')).toHaveTextContent('Send me a code');
  expect(screen.queryByText(/database secret detail/)).toBeNull();
  await waitFor(() => expect(recordClientRecoveryFailure).toHaveBeenCalledWith('phone_submit_failed'));
});
