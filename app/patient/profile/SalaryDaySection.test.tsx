import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SalaryDaySection from './SalaryDaySection';

// ─── Phase 4a — salary-date save must not flash the stale value ─────────
//
// Bug: the displayed day was read from the `current` prop, which only
// updates after router.refresh() lands. So after Save the row flashed the
// OLD day ("1st") even though the new day ("25th") had persisted. The fix
// mirrors the saved value into local state and shows that immediately.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

beforeEach(() => refresh.mockClear());

describe('SalaryDaySection', () => {
  it('shows the just-saved day immediately, not the stale prop value', async () => {
    const saveSalaryDay = vi.fn().mockResolvedValue({ error: null });
    render(<SalaryDaySection current={1} saveSalaryDay={saveSalaryDay} />);

    // Starts at the persisted value.
    expect(screen.getByText('1st of the month')).toBeTruthy();

    // Edit → pick the 25th → Save.
    fireEvent.click(screen.getByTestId('profile-salary-day-edit'));
    fireEvent.change(screen.getByTestId('profile-salary-day-select'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('profile-salary-day-save'));

    await waitFor(() => expect(saveSalaryDay).toHaveBeenCalledWith(25));

    // The display reflects the saved value — no revert to "1st".
    await waitFor(() => expect(screen.getByText('25th of the month')).toBeTruthy());
    expect(screen.queryByText('1st of the month')).toBeNull();
    // And a server refresh was still requested (to re-sync from source).
    expect(refresh).toHaveBeenCalled();
  });

  it('a failed save keeps the original value and surfaces the error', async () => {
    const saveSalaryDay = vi.fn().mockResolvedValue({ error: 'Nope.' });
    render(<SalaryDaySection current={1} saveSalaryDay={saveSalaryDay} />);

    fireEvent.click(screen.getByTestId('profile-salary-day-edit'));
    fireEvent.change(screen.getByTestId('profile-salary-day-select'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('profile-salary-day-save'));

    await waitFor(() => expect(screen.getByText('Nope.')).toBeTruthy());
    // Still shows the original persisted day (the save didn't take).
    expect(screen.getByText('1st of the month')).toBeTruthy();
  });
});
