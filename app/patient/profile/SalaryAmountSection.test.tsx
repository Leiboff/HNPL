import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SalaryAmountSection from './SalaryAmountSection';

// ─── SalaryAmountSection — mirrors SalaryDaySection's save-flash fix ────
//
// Same edit-toggle pattern, same bug class avoided: the displayed amount
// must show the just-saved value immediately, not the stale `current` prop
// while waiting for router.refresh() to land.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

beforeEach(() => refresh.mockClear());

describe('SalaryAmountSection', () => {
  it('shows the just-saved amount immediately, not the stale prop value', async () => {
    const saveSalaryAmount = vi.fn().mockResolvedValue({ error: null });
    render(<SalaryAmountSection current={10000} saveSalaryAmount={saveSalaryAmount} />);

    // Starts at the persisted value.
    expect(screen.getByText('R10,000.00 / month')).toBeTruthy();

    // Edit → change to 15000 → Save.
    fireEvent.click(screen.getByTestId('profile-salary-amount-edit'));
    fireEvent.change(screen.getByTestId('profile-salary-amount-input'), { target: { value: '15000' } });
    fireEvent.click(screen.getByTestId('profile-salary-amount-save'));

    await waitFor(() => expect(saveSalaryAmount).toHaveBeenCalledWith(15000));

    // The display reflects the saved value — no revert to R10,000.
    await waitFor(() => expect(screen.getByText('R15,000.00 / month')).toBeTruthy());
    expect(screen.queryByText('R10,000.00 / month')).toBeNull();
    // And a server refresh was still requested (to re-sync from source).
    expect(refresh).toHaveBeenCalled();
  });

  it('a failed save surfaces the error and does not advance the persisted value', async () => {
    const saveSalaryAmount = vi.fn().mockResolvedValue({ error: 'Nope.' });
    render(<SalaryAmountSection current={10000} saveSalaryAmount={saveSalaryAmount} />);

    fireEvent.click(screen.getByTestId('profile-salary-amount-edit'));
    fireEvent.change(screen.getByTestId('profile-salary-amount-input'), { target: { value: '15000' } });
    fireEvent.click(screen.getByTestId('profile-salary-amount-save'));

    await waitFor(() => expect(screen.getByText('Nope.')).toBeTruthy());
    // A failed save leaves editing open (same as SalaryDaySection) rather
    // than reverting, so the input still shows the rejected draft. Cancel
    // and confirm the DISPLAY still reflects the original persisted amount
    // — the save never took.
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.getByText('R10,000.00 / month')).toBeTruthy();
  });

  it('rejects a non-positive amount client-side, without calling the action', async () => {
    const saveSalaryAmount = vi.fn();
    render(<SalaryAmountSection current={null} saveSalaryAmount={saveSalaryAmount} />);

    fireEvent.click(screen.getByTestId('profile-salary-amount-edit'));
    fireEvent.change(screen.getByTestId('profile-salary-amount-input'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('profile-salary-amount-save'));

    expect(await screen.findByText('Enter how much you earn a month.')).toBeTruthy();
    expect(saveSalaryAmount).not.toHaveBeenCalled();
  });

  it('shows an empty state when no income is on file yet', () => {
    render(<SalaryAmountSection current={null} saveSalaryAmount={vi.fn()} />);
    expect(screen.getByText('No income on file')).toBeTruthy();
  });
});
