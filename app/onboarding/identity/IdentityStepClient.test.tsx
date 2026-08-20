import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import IdentityStepClient from './IdentityStepClient';
import { VALID_SA_ID } from '@/lib/testing/saIdFixtures';

// ─── Identity step client — SA ID + salary day + salary amount ──────────
//
// The three fields this step gathers are validated client-side (the server
// action re-validates for real). This file only pins the NEW field's
// behaviour — salary amount — since SA ID + salary day already have their
// own coverage via the server-action tests in lib/onboarding/*.
//
// fireEvent.submit(form) rather than clicking the submit button — same
// convention as CounterSessionForm.test.tsx and friends: happy-dom does not
// reliably run the implicit-submission algorithm for a plain button click,
// so clicking can silently no-op instead of firing onSubmit.

// vi.mock factories are hoisted above local `const`s, so the mock fn must
// be created via vi.hoisted() rather than closed over directly.
const { saveIdAndSalaryDay } = vi.hoisted(() => ({ saveIdAndSalaryDay: vi.fn() }));
vi.mock('@/lib/onboarding/actions', () => ({ saveIdAndSalaryDay }));

beforeEach(() => {
  saveIdAndSalaryDay.mockReset();
  saveIdAndSalaryDay.mockResolvedValue({ error: null, nextPath: '/onboarding' });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, href: '' },
  });
});

function fillIdAndDay() {
  fireEvent.change(screen.getByTestId('onboarding-sa-id'), { target: { value: VALID_SA_ID } });
  // SalaryDayPicker renders each day as a radio button labelled by its pill text.
  fireEvent.click(screen.getByRole('radio', { name: /1st/ }));
}

function submit() {
  fireEvent.submit(screen.getByTestId('onboarding-identity-submit').closest('form')!);
}

describe('IdentityStepClient — salary amount', () => {
  it('blocks submit with a generic message when salary amount is missing', async () => {
    render(<IdentityStepClient />);
    fillIdAndDay();
    submit();

    expect(await screen.findByText('Please enter how much you earn a month.')).toBeTruthy();
    expect(saveIdAndSalaryDay).not.toHaveBeenCalled();
  });

  it('blocks submit for a zero/negative amount', async () => {
    render(<IdentityStepClient />);
    fillIdAndDay();
    fireEvent.change(screen.getByTestId('onboarding-salary-amount'), { target: { value: '0' } });
    submit();

    expect(await screen.findByText('Please enter how much you earn a month.')).toBeTruthy();
    expect(saveIdAndSalaryDay).not.toHaveBeenCalled();
  });

  it('submits all three fields together once the amount is valid', async () => {
    render(<IdentityStepClient />);
    fillIdAndDay();
    fireEvent.change(screen.getByTestId('onboarding-salary-amount'), { target: { value: '15000' } });
    submit();

    await waitFor(() => expect(saveIdAndSalaryDay).toHaveBeenCalledWith({
      saIdNumber:   VALID_SA_ID,
      salaryDay:    1,
      salaryAmount: 15000,
    }));
  });
});
