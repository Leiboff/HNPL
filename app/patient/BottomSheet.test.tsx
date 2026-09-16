import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// ─── BottomSheet — the close contract ───────────────────────────────────
//
// This file exists because of one bug, and the bug was invisible in review.
//
// The close-on-navigation effect originally guarded on `open` alone, on the
// reasoning that a closed sheet closing again is a no-op. But every caller
// mounts BottomSheet only once it is ALREADY open, so the mount-time effect
// ran with open === true and called onClose immediately. The consequences
// were not cosmetic: the action centre shut the instant the bell opened it,
// InstallPrompt's onClose writes a PERMANENT dismissal to localStorage, and
// PostLoginPasskeyPrompt's onClose calls a server action that bumps the
// prompt's frequency cap. Two of the three wrote persistent state on behalf
// of a patient who had touched nothing.
//
// So the pins below are about WHEN onClose fires, not about markup:
//   • never on mount, however the sheet is mounted;
//   • on a real route change;
//   • on the scrim and on Close, which are the two controls;
//   • and, the case the first fix would still have missed, on navigating
//     away and back again.

const pathname = { current: '/patient' };
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
}));

import BottomSheet from './BottomSheet';

function setup(onClose: () => void, open = true) {
  return render(
    <BottomSheet open={open} onClose={onClose} title="Notifications" testid="sheet">
      <p>body</p>
    </BottomSheet>,
  );
}

beforeEach(() => { pathname.current = '/patient'; });

describe('BottomSheet — onClose fires only when it should', () => {
  it('does NOT fire on mount, even though callers mount it already open', () => {
    // The regression. A sheet that closes itself on mount is not a sheet.
    const onClose = vi.fn();
    setup(onClose);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('sheet')).toBeTruthy();
  });

  it('fires on a real route change', () => {
    const onClose = vi.fn();
    const { rerender } = setup(onClose);
    expect(onClose).not.toHaveBeenCalled();

    act(() => { pathname.current = '/patient/orders'; });
    rerender(
      <BottomSheet open onClose={onClose} title="Notifications" testid="sheet">
        <p>body</p>
      </BottomSheet>,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires again when the patient navigates away and back', () => {
    // Seeding the ref once at mount and never updating it would pass the
    // test above and fail this one: returning to the mount-time path would
    // read as "no change" and leave the sheet open over the new screen.
    const onClose = vi.fn();
    const rerenderAt = (path: string, rerender: (ui: React.ReactElement) => void) => {
      act(() => { pathname.current = path; });
      rerender(
        <BottomSheet open onClose={onClose} title="Notifications" testid="sheet">
          <p>body</p>
        </BottomSheet>,
      );
    };
    const { rerender } = setup(onClose);
    rerenderAt('/patient/orders', rerender);
    rerenderAt('/patient', rerender);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('does not fire on a re-render that changes no route', () => {
    const onClose = vi.fn();
    const { rerender } = setup(onClose);
    rerender(
      <BottomSheet open onClose={onClose} title="Notifications" blurb="now with a blurb" testid="sheet">
        <p>body</p>
      </BottomSheet>,
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders nothing when closed, and still does not fire', () => {
    const onClose = vi.fn();
    const { container } = setup(onClose, false);
    expect(container.firstChild).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('BottomSheet — the two controls', () => {
  it('closes on the Close button', () => {
    const onClose = vi.fn();
    setup(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on the scrim — the one people reach for on a phone', () => {
    const onClose = vi.fn();
    const { container } = setup(onClose);
    const scrim = container.querySelector('.bn-scrim');
    expect(scrim).toBeTruthy();
    fireEvent.click(scrim!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    setup(onClose);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
