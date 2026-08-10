import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DeviceAdminView from './DeviceAdminView';
import type { DeviceRow } from './actions';

// ─── DeviceAdminView — Set/Reset PIN label, generator, mask/reveal ────────
//
// Action props are injected directly (same pattern as
// CounterSessionForm.test.tsx / PracticeApprovalRow.test.tsx) rather than
// mocking modules.

const NOOP_DEVICES: DeviceRow[] = [];

function renderView(overrides: {
  hasPin?: boolean;
  generateTillPinValue?: (practiceId?: string) => Promise<{ error: string | null; pin?: string }>;
  setTillPin?: (pin: string, practiceId?: string) => Promise<{ error: string | null }>;
} = {}) {
  const generateDeviceRegistrationCode = vi.fn(async () => ({ error: null, code: '12345678', expiresAt: new Date().toISOString() }));
  const revokeDevice = vi.fn(async () => ({ error: null }));
  const setTillPin = overrides.setTillPin ?? vi.fn(async () => ({ error: null }));
  const generateTillPinValue = overrides.generateTillPinValue ?? vi.fn(async () => ({ error: null, pin: '482913' }));

  render(
    <DeviceAdminView
      practiceId="practice-1"
      initialDevices={NOOP_DEVICES}
      hasPin={overrides.hasPin ?? false}
      generateDeviceRegistrationCode={generateDeviceRegistrationCode}
      revokeDevice={revokeDevice}
      setTillPin={setTillPin}
      generateTillPinValue={generateTillPinValue}
    />,
  );

  return { generateDeviceRegistrationCode, revokeDevice, setTillPin, generateTillPinValue };
}

describe('DeviceAdminView — Set PIN vs Reset PIN label', () => {
  it('reads "Set PIN" when no PIN is configured yet (manual-entry path)', () => {
    renderView({ hasPin: false });
    expect(screen.getByTestId('till-pin-submit').textContent).toBe('Set PIN');
    expect(screen.getByTestId('no-pin-banner')).toBeTruthy();
  });

  it('reads "Reset PIN" when a PIN is already configured (manual-entry path)', () => {
    renderView({ hasPin: true });
    expect(screen.getByTestId('till-pin-submit').textContent).toBe('Reset PIN');
    expect(screen.queryByTestId('no-pin-banner')).toBeNull();
  });

  it('reads "Set PIN" before a first save even after using the generator', async () => {
    renderView({ hasPin: false });
    fireEvent.click(screen.getByTestId('till-pin-generate'));
    await waitFor(() => expect((screen.getByTestId('till-pin-input') as HTMLInputElement).value).toBe('482913'));
    // Still "Set PIN" — generating fills the field, it doesn't save anything.
    expect(screen.getByTestId('till-pin-submit').textContent).toBe('Set PIN');
  });

  it('flips to "Reset PIN" immediately after a successful save via the generator path', async () => {
    renderView({ hasPin: false });
    fireEvent.click(screen.getByTestId('till-pin-generate'));
    await waitFor(() => expect((screen.getByTestId('till-pin-input') as HTMLInputElement).value).toBe('482913'));
    fireEvent.submit(screen.getByTestId('till-pin-input').closest('form')!);
    await waitFor(() => expect(screen.getByTestId('till-pin-submit').textContent).toBe('Reset PIN'));
  });
});

describe('DeviceAdminView — Generate a PIN', () => {
  it('fills the field with the generated PIN and reveals it (respecting the mask/reveal toggle)', async () => {
    renderView({ hasPin: false });
    const input = screen.getByTestId('till-pin-input') as HTMLInputElement;
    expect(input.type).toBe('password');

    fireEvent.click(screen.getByTestId('till-pin-generate'));
    await waitFor(() => expect(input.value).toBe('482913'));
    // Auto-revealed so the manager can actually read it to note it down.
    expect(input.type).toBe('text');

    // Still togglable afterward.
    fireEvent.click(screen.getByTestId('till-pin-input-toggle'));
    expect(input.type).toBe('password');
  });

  it('submits the exact generated value through setTillPin, never a different/rehashed value', async () => {
    const { setTillPin } = renderView({ hasPin: false });
    fireEvent.click(screen.getByTestId('till-pin-generate'));
    await waitFor(() => expect((screen.getByTestId('till-pin-input') as HTMLInputElement).value).toBe('482913'));
    fireEvent.submit(screen.getByTestId('till-pin-input').closest('form')!);
    await waitFor(() => expect(setTillPin).toHaveBeenCalledWith('482913', 'practice-1'));
  });

  it('a generation error is shown and the field is left untouched', async () => {
    const generateTillPinValue = vi.fn(async () => ({ error: 'Server configuration error — please contact support.' }));
    renderView({ generateTillPinValue });
    fireEvent.click(screen.getByTestId('till-pin-generate'));
    await waitFor(() => expect(screen.getByText(/configuration/i)).toBeTruthy());
    expect((screen.getByTestId('till-pin-input') as HTMLInputElement).value).toBe('');
  });

  it('never logs the generated PIN to the console', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderView({ hasPin: false });
    fireEvent.click(screen.getByTestId('till-pin-generate'));
    await waitFor(() => expect((screen.getByTestId('till-pin-input') as HTMLInputElement).value).toBe('482913'));

    const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join('\n');
    expect(allLoggedText).not.toContain('482913');
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('DeviceAdminView — PIN field masked by default', () => {
  it('the till-pin field is type="password" on initial render', () => {
    renderView();
    expect((screen.getByTestId('till-pin-input') as HTMLInputElement).type).toBe('password');
  });

  it('typing manually keeps it masked until the manager explicitly reveals it', () => {
    renderView();
    const input = screen.getByTestId('till-pin-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '135790' } });
    expect(input.type).toBe('password');
    fireEvent.click(screen.getByTestId('till-pin-input-toggle'));
    expect(input.type).toBe('text');
  });
});
