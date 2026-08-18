import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PhoneField from './PhoneField';
import { maskPhone } from '@/lib/patient/maskContact';

// ─── Phone field — no stale flash on save + SA-mobile validation ────────
//
// Three behaviours under test:
//   1. After a successful save the row shows the just-saved value
//      immediately — never reverting to the stale `current` prop until
//      router.refresh() lands.
//   2. The number is validated as an SA mobile: valid input is normalised
//      to E.164 and sent; invalid input is blocked inline with NO "Saved."
//      and NO call to the server action.
//   3. The displayed value is MASKED, and the real number appears only in
//      the edit input.
//
// ─── ON THE MASK, AND WHY THESE PINS MOVED ────────────────────────────
//
// The display assertions used to compare against the full number. They now
// compare against `maskPhone(<full number>)` — computed with the same helper
// the component uses, so the pin cannot drift from the masking rule, and a
// change to the masking rule updates both sides together instead of
// silently passing.
//
// This is a RE-DERIVATION, not a relaxation. What the original pins
// protected was that the display ADVANCES to the just-saved value rather
// than showing the stale prop, and every one of them still proves exactly
// that: the mask of the new number differs from the mask of the old one in
// each case below. Two things were ADDED that the originals could not
// assert, because the full value was on screen:
//
//   • the raw number never appears in the DOM while not editing;
//   • it DOES appear in the input once editing, because a masked field
//     that cannot be edited is not an editable field.

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

    expect(screen.getByTestId('profile-phone-value').textContent).toBe(maskPhone('+27820000000'));

    editAndType('0821234567');

    // Sent normalised to E.164.
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ phone: '+27821234567' }));
    // Display reflects the saved value — no revert to the old number.
    await waitFor(() => expect(screen.getByTestId('profile-phone-value').textContent).toBe(maskPhone('+27821234567')));
    expect(screen.getByText('Saved.')).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it('normalises +27… input as well', async () => {
    const updateProfile = vi.fn().mockResolvedValue({ error: null });
    render(<PhoneField current={null} updateProfile={updateProfile} />);

    editAndType('+27821234567');

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ phone: '+27821234567' }));
    await waitFor(() => expect(screen.getByTestId('profile-phone-value').textContent).toBe(maskPhone('+27821234567')));
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
    expect(screen.getByTestId('profile-phone-value').textContent).toBe(maskPhone('+27820000000'));
  });

  it('an empty value clears the number (sends null)', async () => {
    const updateProfile = vi.fn().mockResolvedValue({ error: null });
    render(<PhoneField current="+27821234567" updateProfile={updateProfile} />);

    editAndType('');

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ phone: null }));
    // Cleared → an empty state with an icon and a sentence, where an
    // uninformative em-dash used to be. Still the same testid, so the
    // "display advanced past the old value" guarantee is intact: the old
    // number is gone from the row.
    await waitFor(() => {
      const row = screen.getByTestId('profile-phone-value');
      expect(row.textContent).toContain('No mobile number');
      expect(row.textContent).not.toContain('4567');
    });
    expect(screen.getByTestId('empty-state')).toBeTruthy();
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
    await waitFor(() => expect(screen.getByTestId('profile-phone-value').textContent).toBe(maskPhone('+27821234567')));
  });

  it('MASKED: the real number is not in the DOM until you edit', () => {
    // The guarantee the old full-value pins could not make. A patient opening
    // their account in a waiting room should not have their mobile number on
    // screen, for the same reason the SA ID beside it is masked.
    const updateProfile = vi.fn().mockResolvedValue({ error: null });
    const { container } = render(
      <PhoneField current="+27821234567" updateProfile={updateProfile} />,
    );

    expect(container.textContent).not.toContain('+27821234567');
    expect(container.textContent).toContain(maskPhone('+27821234567'));
    // Only the last four survive the mask.
    expect(container.textContent).toContain('4567');
    expect(container.textContent).not.toContain('2712');
  });

  it('MASKED BUT EDITABLE: tapping Edit reveals the real value in the input', () => {
    // The other half, and the one that would make masking a regression if it
    // broke: a field you cannot read cannot be corrected. The input must hold
    // the true value, not the bullets.
    const updateProfile = vi.fn().mockResolvedValue({ error: null });
    render(<PhoneField current="+27821234567" updateProfile={updateProfile} />);

    fireEvent.click(screen.getByTestId('profile-phone-edit'));
    const input = screen.getByTestId('profile-phone-input') as HTMLInputElement;
    expect(input.value).toBe('+27821234567');
    expect(input.value).not.toContain('•');
  });
});
