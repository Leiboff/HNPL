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
  initialDevices?: DeviceRow[];
  generateTillPinValue?: (practiceId?: string) => Promise<{ error: string | null; pin?: string }>;
  setTillPin?: (pin: string, practiceId?: string) => Promise<{ error: string | null }>;
  relabelDevice?: (deviceId: string, label: string) => Promise<{ error: string | null }>;
} = {}) {
  const generateDeviceRegistrationCode = vi.fn(async () => ({ error: null, code: '12345678', expiresAt: new Date().toISOString() }));
  const revokeDevice = vi.fn(async () => ({ error: null }));
  const setTillPin = overrides.setTillPin ?? vi.fn(async () => ({ error: null }));
  const generateTillPinValue = overrides.generateTillPinValue ?? vi.fn(async () => ({ error: null, pin: '482913' }));
  const relabelDevice = overrides.relabelDevice ?? vi.fn(async () => ({ error: null }));

  render(
    <DeviceAdminView
      practiceId="practice-1"
      initialDevices={overrides.initialDevices ?? NOOP_DEVICES}
      hasPin={overrides.hasPin ?? false}
      generateDeviceRegistrationCode={generateDeviceRegistrationCode}
      revokeDevice={revokeDevice}
      setTillPin={setTillPin}
      generateTillPinValue={generateTillPinValue}
      relabelDevice={relabelDevice}
    />,
  );

  return { generateDeviceRegistrationCode, revokeDevice, setTillPin, generateTillPinValue, relabelDevice };
}

const S23_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const DEVICE: DeviceRow = {
  id: 'device-1', label: 'Front desk PC', userAgent: S23_UA,
  registeredAt: '2024-01-01T08:00:00Z', revokedAt: null, revokedBy: null, lastActivityAt: null, unlockedAt: null,
};
// Shares BOTH label and OS-derived model with DEVICE — the code (Part 2)
// is the only thing that can tell these two apart.
const TWIN_DEVICE: DeviceRow = {
  id: 'device-2', label: 'Front desk PC', userAgent: S23_UA,
  registeredAt: '2024-01-02T08:00:00Z', revokedAt: null, revokedBy: null, lastActivityAt: null, unlockedAt: null,
};
const REVOKED_DEVICE: DeviceRow = {
  id: 'device-3', label: 'Old reception PC', userAgent: WINDOWS_UA,
  registeredAt: '2023-06-01T08:00:00Z', revokedAt: '2024-02-01T10:00:00Z', revokedBy: 'Jane Doe',
  lastActivityAt: '2024-01-30T09:00:00Z', unlockedAt: '2024-01-30T08:00:00Z',
};

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

describe('DeviceAdminView — device name + model + rename', () => {
  it('shows the device name and the model derived from its user-agent', () => {
    renderView({ initialDevices: [DEVICE] });
    expect(screen.getByText('Front desk PC')).toBeTruthy();
    // The S23's UA (SM-S911B) is surfaced as a readable model.
    expect(screen.getByTestId('device-model-device-1').textContent).toBe('Samsung SM-S911B (Android 13)');
  });

  it('renames a device through relabelDevice and reflects the new name', async () => {
    const relabelDevice = vi.fn(async () => ({ error: null }));
    renderView({ initialDevices: [DEVICE], relabelDevice });

    fireEvent.click(screen.getByTestId('rename-device-1'));
    const input = screen.getByTestId('rename-input-device-1') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Reception iPad' } });
    fireEvent.click(screen.getByTestId('rename-save-device-1'));

    await waitFor(() => expect(relabelDevice).toHaveBeenCalledWith('device-1', 'Reception iPad'));
    await waitFor(() => expect(screen.getByText('Reception iPad')).toBeTruthy());
  });

  it('blocks saving an empty name and surfaces the server error', async () => {
    const relabelDevice = vi.fn(async () => ({ error: 'boom' }));
    renderView({ initialDevices: [DEVICE], relabelDevice });

    fireEvent.click(screen.getByTestId('rename-device-1'));
    fireEvent.change(screen.getByTestId('rename-input-device-1'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('rename-save-device-1'));

    // Client-side guard fires first — server action never called on blank.
    await waitFor(() => expect(screen.getByText(/enter a name/i)).toBeTruthy());
    expect(relabelDevice).not.toHaveBeenCalled();
  });
});

describe('DeviceAdminView — device code (Part 2)', () => {
  it('shows a distinct code for two devices that share BOTH a label and a model', () => {
    renderView({ initialDevices: [DEVICE, TWIN_DEVICE] });
    const codeA = screen.getByTestId('device-code-device-1').textContent;
    const codeB = screen.getByTestId('device-code-device-2').textContent;
    expect(codeA).toBeTruthy();
    expect(codeB).toBeTruthy();
    expect(codeA).not.toBe(codeB);
  });

  it('the code is stable across re-renders (not regenerated per render)', () => {
    const { rerender } = render(
      <DeviceAdminView
        practiceId="practice-1"
        initialDevices={[DEVICE]}
        hasPin={false}
        generateDeviceRegistrationCode={vi.fn()}
        revokeDevice={vi.fn()}
        setTillPin={vi.fn()}
        generateTillPinValue={vi.fn()}
        relabelDevice={vi.fn()}
      />,
    );
    const first = screen.getByTestId('device-code-device-1').textContent;
    rerender(
      <DeviceAdminView
        practiceId="practice-1"
        initialDevices={[DEVICE]}
        hasPin={false}
        generateDeviceRegistrationCode={vi.fn()}
        revokeDevice={vi.fn()}
        setTillPin={vi.fn()}
        generateTillPinValue={vi.fn()}
        relabelDevice={vi.fn()}
      />,
    );
    expect(screen.getByTestId('device-code-device-1').textContent).toBe(first);
  });
});

describe('DeviceAdminView — Active / Revoked tabs (Part 3)', () => {
  it('defaults to the Active tab on load', () => {
    renderView({ initialDevices: [DEVICE, REVOKED_DEVICE] });
    expect(screen.getByTestId('tab-active').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('active-device-list')).toBeTruthy();
    expect(screen.queryByTestId('revoked-device-list')).toBeNull();
  });

  it('partitions devices correctly: active-only in Active, revoked-only in Revoked', () => {
    renderView({ initialDevices: [DEVICE, REVOKED_DEVICE] });
    expect(screen.getByText('Front desk PC')).toBeTruthy();
    expect(screen.queryByText('Old reception PC')).toBeNull();

    fireEvent.click(screen.getByTestId('tab-revoked'));
    expect(screen.getByText('Old reception PC')).toBeTruthy();
    expect(screen.queryByText('Front desk PC')).toBeNull();
  });

  it('the Revoked tab shows registered/last-active/revoked-date-and-by and the device code, with NO rename/revoke controls', () => {
    renderView({ initialDevices: [REVOKED_DEVICE] });
    fireEvent.click(screen.getByTestId('tab-revoked'));

    expect(screen.getByTestId('revoked-info-device-3').textContent).toMatch(/Revoked.*by Jane Doe/);
    expect(screen.getByTestId('device-code-device-3').textContent).toBeTruthy();
    expect(screen.getByTestId('revoked-device-list').textContent).toMatch(/Registered.*Last active/);

    expect(screen.queryByTestId('rename-device-3')).toBeNull();
    expect(screen.queryByTestId('revoke-device-3')).toBeNull();
  });

  it('the Active tab keeps Rename/Revoke available; the Revoked tab never gains them', () => {
    renderView({ initialDevices: [DEVICE, REVOKED_DEVICE] });
    expect(screen.getByTestId('rename-device-1')).toBeTruthy();
    expect(screen.getByTestId('revoke-device-1')).toBeTruthy();

    fireEvent.click(screen.getByTestId('tab-revoked'));
    expect(screen.queryByTestId('rename-device-3')).toBeNull();
    expect(screen.queryByTestId('revoke-device-3')).toBeNull();
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
