import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PhoneField from './PhoneField';

// ─── Phone field — no stale flash on save + SA-mobile validation ────────
//
// Two behaviours under test:
//   1. After a successful save the row shows the just-saved value (in
//      canonical +27… form) immediately — never reverting to the stale
//      `current` prop until router.refresh() lands.
//   2. The number is validated as an SA mobile: valid input is normalised
//      to E.164 and sent; invalid input is blocked inline with NO "Saved."
//      and NO call to the server action.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

beforeEach(() => refresh.mockClear());

function editAndType(value: string) {
  fireEvent.click(screen.getByTestId('profile-phone-edit'));
  fireEvent.change(screen.getByTestId('profile-phone-input'), { target: { value } });
  fireEvent.click(screen.getByTestId('profile-phone-save'));
}

describe('PhoneField', () => {
  it('shows the just-saved (normalised) number immediately, not the stale prop', async () => {
    const updateProfile = vi.fn().mockResolvedValue({ error: null });
    render(<PhoneField current="+27820000000" updateProfile={updateProfile} />);

    expect(screen.getByTestId('profile-phone-value').textContent).toBe('+27820000000');

    editAndType('0821234567');

    // Sent normalised to E.164.
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ phone: '+27821234567' }));
    // Display reflects the saved value — no revert to the old number.
    await waitFor(() => expect(screen.getByTestId('profile-phone-value').textContent).toBe('+27821234567'));
    expect(screen.getByText('Saved.')).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it('normalises +27… input as well', async () => {
    const updateProfile = vi.fn().mockResolvedValue({ error: null });
    render(<PhoneField current={null} updateProfile={updateProfile} />);

    editAndType('+27821234567');

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ phone: '+27821234567' }));
    await waitFor(() => expect(screen.getByTestId('profile-phone-value').textContent).toBe('+27821234567'));
  });

  it('rejects letters/symbols inline and does NOT save', async () => {
    const updateProfile = vi.fn().mockResolvedValue({ error: null });
    render(<PhoneField current="+27821234567" updateProfile={updateProfile} />);

    editAndType('abcxyz!!');

    await waitFor(() => expect(screen.getByText(/valid South African mobile/i)).toBeTruthy());
    expect(updateProfile).not.toHaveBeenCalled();
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it.each(['2222', '08212345', '08212345678'])('rejects wrong-length input %s', async (bad) => {
    const updateProfile = vi.fn().mockResolvedValue({ error: null });
    render(<PhoneField current={null} updateProfile={updateProfile} />);

    editAndType(bad);

    await waitFor(() => expect(screen.getByText(/valid South African mobile/i)).toBeTruthy());
    expect(updateProfile).not.toHaveBeenCalled();
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('a server-side rejection shows the error, keeps the old value, no "Saved."', async () => {
    const updateProfile = vi.fn().mockResolvedValue({ error: 'Nope.' });
    render(<PhoneField current="+27820000000" updateProfile={updateProfile} />);

    editAndType('0821234567');

    await waitFor(() => expect(screen.getByText('Nope.')).toBeTruthy());
    expect(screen.queryByText('Saved.')).toBeNull();
    // Stays in edit mode so the user can retry; the mirror never advanced —
    // cancelling reveals the original value, proving no stale/partial update.
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.getByTestId('profile-phone-value').textContent).toBe('+27820000000');
  });

  it('an empty value clears the number (sends null)', async () => {
    const updateProfile = vi.fn().mockResolvedValue({ error: null });
    render(<PhoneField current="+27821234567" updateProfile={updateProfile} />);

    editAndType('');

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ phone: null }));
    await waitFor(() => expect(screen.getByTestId('profile-phone-value').textContent).toBe('—'));
  });

  it('a rapid double-Save fires a single mutation (button disabled while pending)', async () => {
    let resolve!: (v: { error: string | null }) => void;
    const updateProfile = vi.fn(() => new Promise<{ error: string | null }>((r) => { resolve = r; }));
    render(<PhoneField current={null} updateProfile={updateProfile} />);

    fireEvent.click(screen.getByTestId('profile-phone-edit'));
    fireEvent.change(screen.getByTestId('profile-phone-input'), { target: { value: '0821234567' } });
    const saveBtn = screen.getByTestId('profile-phone-save');
    fireEvent.click(saveBtn);
    fireEvent.click(saveBtn); // second click while pending

    await waitFor(() => expect(saveBtn.hasAttribute('disabled')).toBe(true));
    expect(updateProfile).toHaveBeenCalledTimes(1);

    resolve({ error: null });
    await waitFor(() => expect(screen.getByTestId('profile-phone-value').textContent).toBe('+27821234567'));
  });
});
