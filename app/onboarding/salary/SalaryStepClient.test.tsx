import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SalaryStepClient from './SalaryStepClient';

// ─── Salary step client ────────────────────────────────────────────────
//
// Moved out of IdentityStepClient when the combined identity+salary step
// was split. These are the same validation cases that lived there, plus
// coverage for the one behaviour the split changed: this form now always
// navigates to the server-supplied nextPath, because completing it
// always advances the journey. In the combined step it could legitimately
// stay put (the identity half might still be outstanding), so navigation
// was conditional — that condition no longer applies and its absence
// needs pinning.
//
// fireEvent.submit(form) rather than clicking the button — happy-dom does
// not reliably run the implicit-submission algorithm for a plain click.

const { saveSalaryDetails } = vi.hoisted(() => ({ saveSalaryDetails: vi.fn() }));
vi.mock('@/lib/onboarding/actions', () => ({ saveSalaryDetails }));

beforeEach(() => {
  saveSalaryDetails.mockReset();
  saveSalaryDetails.mockResolvedValue({ error: null, nextPath: '/onboarding/identity' });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, href: '' },
  });
});

function submitForm() {
  fireEvent.submit(screen.getByTestId('onboarding-salary-form'));
}

describe('validation — blocks submit before calling the server', () => {
  it('requires a salary day', async () => {
    render(<SalaryStepClient salaryDay={null} salaryAmount={null} />);
    fireEvent.change(screen.getByTestId('onboarding-salary-amount'), { target: { value: '15000' } });
    submitForm();

    expect(await screen.findByText('Please choose when your salary is paid.')).toBeTruthy();
    expect(saveSalaryDetails).not.toHaveBeenCalled();
  });

  it('rejects a zero or negative amount', async () => {
    render(<SalaryStepClient salaryDay={25} salaryAmount={null} />);
    fireEvent.change(screen.getByTestId('onboarding-salary-amount'), { target: { value: '0' } });
    submitForm();

    expect(await screen.findByText('Please enter how much you earn a month.')).toBeTruthy();
    expect(saveSalaryDetails).not.toHaveBeenCalled();
  });

  it('rejects a missing amount', async () => {
    render(<SalaryStepClient salaryDay={25} salaryAmount={null} />);
    submitForm();

    expect(await screen.findByText('Please enter how much you earn a month.')).toBeTruthy();
    expect(saveSalaryDetails).not.toHaveBeenCalled();
  });
});

describe('submission', () => {
  it('sends day + amount once both are valid', async () => {
    render(<SalaryStepClient salaryDay={25} salaryAmount={null} />);
    fireEvent.change(screen.getByTestId('onboarding-salary-amount'), { target: { value: '15000' } });
    submitForm();

    await waitFor(() => expect(saveSalaryDetails).toHaveBeenCalledWith({
      salaryDay: 25, salaryAmount: 15000,
    }));
  });

  it('always follows the server-supplied nextPath', async () => {
    // The split's one behavioural change. In the combined step,
    // navigation was conditional — saving salary did not necessarily
    // advance anything, because the identity half might still be
    // outstanding on the same screen. Now this step IS the whole screen,
    // so completing it always moves on, and the server decides where
    // (it knows whether the credit check is enabled and auto-passed).
    saveSalaryDetails.mockResolvedValue({ error: null, nextPath: '/onboarding/identity' });

    render(<SalaryStepClient salaryDay={1} salaryAmount={null} />);
    fireEvent.change(screen.getByTestId('onboarding-salary-amount'), { target: { value: '9000' } });
    submitForm();

    await waitFor(() => expect(window.location.href).toBe('/onboarding/identity'));
  });

  it('follows nextPath to credit-check when the server sends it there', async () => {
    // Never hardcode the next step: with ENABLE_CREDIT_CHECK on, the
    // server routes somewhere this component knows nothing about.
    saveSalaryDetails.mockResolvedValue({ error: null, nextPath: '/onboarding/credit-check' });

    render(<SalaryStepClient salaryDay={1} salaryAmount={null} />);
    fireEvent.change(screen.getByTestId('onboarding-salary-amount'), { target: { value: '9000' } });
    submitForm();

    await waitFor(() => expect(window.location.href).toBe('/onboarding/credit-check'));
  });

  it('surfaces a server error and does NOT navigate', async () => {
    saveSalaryDetails.mockResolvedValue({ error: 'Something went wrong.', nextPath: '/onboarding/salary' });

    render(<SalaryStepClient salaryDay={1} salaryAmount={null} />);
    fireEvent.change(screen.getByTestId('onboarding-salary-amount'), { target: { value: '9000' } });
    submitForm();

    expect(await screen.findByText('Something went wrong.')).toBeTruthy();
    expect(window.location.href).toBe('');
  });
});

describe('prefill', () => {
  it('shows existing values when the patient has already saved them', () => {
    render(<SalaryStepClient salaryDay={25} salaryAmount={15000} />);
    expect((screen.getByTestId('onboarding-salary-amount') as HTMLInputElement).value).toBe('15000');
  });
});

describe('separation from identity', () => {
  it('renders no SA ID field and no consent checkbox', () => {
    // The point of the split. Asking for a government ID number and
    // biometric consent on the same screen as a pay-date picker was the
    // problem; this pins the two apart so they cannot drift back
    // together.
    render(<SalaryStepClient salaryDay={null} salaryAmount={null} />);
    expect(screen.queryByTestId('onboarding-sa-id')).toBeNull();
    expect(screen.queryByTestId('onboarding-dha-consent')).toBeNull();
  });
});
