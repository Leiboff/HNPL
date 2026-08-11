import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DeviceAdminView from './DeviceAdminView';
import PinInput from '../PinInput';
import type { DeviceRow } from './actions';

// ─── The PIN field's RENDERED DOM output, masked AND revealed ──────────────
//
// WHY THIS FILE EXISTS: pinRoundTrip.test.ts proved the SERVER side agrees
// (generate -> setTillPin -> unlockTill all hash the same value), but it
// never mounted a component or clicked the reveal toggle — so it could not
// have caught a field that DISPLAYS something other than the real PIN.
// Reported symptom: masked showed ~7 dots, then clicking the eye rendered
// the single literal character "6".
//
// Masked and revealed are the SAME <input> with the SAME value={value}
// prop (PinInput.tsx) — only `type` flips password/text. So the two render
// paths cannot desync inside React; a wrong revealed value can ONLY come
// from something writing the DOM node from OUTSIDE React and that write
// being accepted. Which is exactly what a browser password manager does:
// Chrome IGNORES autoComplete="off" on type="password" and autofills a
// saved site credential, and the digits-only sanitizer then silently
// reduces e.g. "Passw6rd" to "6".
//
// Every assertion below reads the REAL input's .value / .type out of the
// DOM in both states — never a mock, never a server action's return value.

const GENERATED_PIN = '482913';

function renderAdmin(overrides: {
  hasPin?: boolean;
  generateTillPinValue?: (practiceId?: string) => Promise<{ error: string | null; pin?: string }>;
  setTillPin?: (pin: string, practiceId?: string) => Promise<{ error: string | null }>;
} = {}) {
  const setTillPin = overrides.setTillPin ?? vi.fn(async () => ({ error: null }));
  const generateTillPinValue = overrides.generateTillPinValue
    ?? vi.fn(async () => ({ error: null, pin: GENERATED_PIN }));

  render(
    <DeviceAdminView
      practiceId="practice-1"
      initialDevices={[] as DeviceRow[]}
      hasPin={overrides.hasPin ?? false}
      generateDeviceRegistrationCode={vi.fn(async () => ({ error: null, code: '12345678', expiresAt: new Date().toISOString() }))}
      revokeDevice={vi.fn(async () => ({ error: null }))}
      setTillPin={setTillPin}
      generateTillPinValue={generateTillPinValue}
      relabelDevice={vi.fn(async () => ({ error: null }))}
    />,
  );

  const field  = () => screen.getByTestId('till-pin-input') as HTMLInputElement;
  const toggle = () => screen.getByTestId('till-pin-input-toggle');
  return { setTillPin, generateTillPinValue, field, toggle };
}

// ─── THE REPRODUCTION ─────────────────────────────────────────────────────
//
// fireEvent.change here is a FAITHFUL model of a password-manager autofill,
// not a contrived event: an external agent sets the node's value and the
// browser fires an input event. That is byte-for-byte the path Chrome
// autofill takes, and it is the only way the "6" can reach the screen.
describe('till PIN field — a password-manager autofill must never become the PIN', () => {
  it('an autofilled site credential is REJECTED outright, not silently reduced to its digits', () => {
    const { field, toggle } = renderAdmin();

    // Chrome autofills the saved password for this site into the masked
    // field. The manager sees ~7 dots and clicks the eye to inspect it.
    fireEvent.change(field(), { target: { value: 'Passw6rd' } });
    fireEvent.click(toggle());

    // The revealed text must NOT be the sanitizer's leftover digit.
    expect(field().value).not.toBe('6');
    // Nothing partial at all: a non-numeric external fill is not a PIN.
    expect(field().value).toBe('');
  });

  it('carries attributes that stop the autofill at source (autoComplete="off" is ignored by Chrome on password fields)', () => {
    const { field } = renderAdmin();
    // "new-password" is the value Chrome actually honours to suppress
    // filling a SAVED credential; "off" is not.
    expect(field().getAttribute('autocomplete')).toBe('new-password');
    // Password-manager opt-outs (1Password / LastPass / Bitwarden).
    expect(field().getAttribute('data-1p-ignore')).toBe('true');
    expect(field().getAttribute('data-lpignore')).toBe('true');
    expect(field().getAttribute('data-bwignore')).toBe('true');
  });
});

// ─── Masked value == revealed value == the real PIN ────────────────────────
describe('till PIN field — masked and revealed always show the exact same real value', () => {
  it('GENERATED pin: the masked field already holds it exactly, and revealing shows exactly it', async () => {
    const { field, toggle, setTillPin } = renderAdmin();

    fireEvent.click(screen.getByTestId('till-pin-generate'));
    await waitFor(() => expect(field().value).toBe(GENERATED_PIN));

    // The generator auto-reveals; hide it and confirm the UNDERLYING value
    // is untouched by masking (dot-count is cosmetic, the value is not).
    fireEvent.click(toggle());
    expect(field().type).toBe('password');
    expect(field().value).toBe(GENERATED_PIN);

    // Reveal again — character-for-character the same real PIN.
    fireEvent.click(toggle());
    expect(field().type).toBe('text');
    expect(field().value).toBe(GENERATED_PIN);

    // ...and that exact string is what gets submitted for hashing.
    fireEvent.submit(field().closest('form')!);
    await waitFor(() => expect(setTillPin).toHaveBeenCalledWith(GENERATED_PIN, 'practice-1'));
  });

  it('MANUALLY TYPED pin: same equality holds (not just the generator path)', async () => {
    const { field, toggle, setTillPin } = renderAdmin();

    fireEvent.change(field(), { target: { value: '135790' } });
    expect(field().type).toBe('password');
    expect(field().value).toBe('135790');

    fireEvent.click(toggle());
    expect(field().type).toBe('text');
    expect(field().value).toBe('135790');

    fireEvent.submit(field().closest('form')!);
    await waitFor(() => expect(setTillPin).toHaveBeenCalledWith('135790', 'practice-1'));
  });

  it('repeated toggling never drifts, truncates, or resets the value', async () => {
    const { field, toggle } = renderAdmin();
    fireEvent.click(screen.getByTestId('till-pin-generate'));
    await waitFor(() => expect(field().value).toBe(GENERATED_PIN));

    // The generator leaves the field REVEALED, so odd clicks land masked
    // and even clicks land revealed. Assert the type parity on every step
    // as well as the value, so a toggle that silently stops responding
    // can't pass this test.
    expect(field().type).toBe('text');
    for (let i = 1; i <= 6; i++) {
      fireEvent.click(toggle());
      expect(field().type).toBe(i % 2 === 1 ? 'password' : 'text');
      expect(field().value).toBe(GENERATED_PIN);
    }
  });

  it('adversarial: after a successful Reset PIN, NO character of the old PIN survives in the field', async () => {
    const { field, toggle } = renderAdmin({ hasPin: true });

    fireEvent.change(field(), { target: { value: '111111' } });
    fireEvent.click(toggle());
    expect(field().value).toBe('111111');

    fireEvent.submit(field().closest('form')!);
    await waitFor(() => expect(screen.getByText(/PIN saved/i)).toBeTruthy());

    // Cleared completely, and re-masked — not "1", not "11111", nothing.
    expect(field().value).toBe('');
    expect(field().type).toBe('password');
    fireEvent.click(toggle());
    expect(field().value).toBe('');
  });
});

// ─── PinInput in isolation — the same guarantees at unit level ─────────────
describe('PinInput — the reveal toggle renders the controlled value verbatim', () => {
  function Harness({ initial = '' }: { initial?: string }) {
    const [v, setV] = useState(initial);
    return <PinInput value={v} onChange={setV} testId="pin" />;
  }

  it('accepts digits and rejects a non-numeric external fill instead of partially keeping it', () => {
    render(<Harness />);
    const input = screen.getByTestId('pin') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '4829' } });
    expect(input.value).toBe('4829');

    // A password-manager style fill must not overwrite good input with junk.
    fireEvent.change(input, { target: { value: 'Passw6rd' } });
    expect(input.value).toBe('4829');

    // Whitespace around a pasted PIN is tolerated (trimmed, not rejected).
    fireEvent.change(input, { target: { value: '  482913  ' } });
    expect(input.value).toBe('482913');
  });

  it('the value is identical in masked and revealed states', () => {
    render(<Harness initial="482913" />);
    const input = screen.getByTestId('pin') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('482913');
    fireEvent.click(screen.getByTestId('pin-toggle'));
    expect(input.type).toBe('text');
    expect(input.value).toBe('482913');
  });
});
