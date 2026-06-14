import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import OtpInput, { OTP_LENGTH } from './OtpInput';

// ─── Harness ────────────────────────────────────────────────────────────────

function Harness({
  onChangeSpy,
  onCompleteSpy,
}: {
  onChangeSpy?:   (s: string) => void;
  onCompleteSpy?: (s: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <OtpInput
      value={value}
      onChange={(s) => { setValue(s); onChangeSpy?.(s); }}
      onComplete={onCompleteSpy}
    />
  );
}

function cells(): HTMLInputElement[] {
  return Array.from({ length: OTP_LENGTH }, (_, i) =>
    document.getElementById(`otp-${i}`) as HTMLInputElement,
  );
}

// ─── OTP_LENGTH constant ────────────────────────────────────────────────────

describe('OTP_LENGTH', () => {
  it('is exactly 6 (matches Supabase dashboard OTP length)', () => {
    expect(OTP_LENGTH).toBe(6);
  });
});

// ─── Rendering ──────────────────────────────────────────────────────────────

describe('OtpInput — render', () => {
  it('renders six numeric cells', () => {
    render(<Harness />);
    const all = cells();
    expect(all).toHaveLength(6);
    for (const c of all) {
      expect(c.getAttribute('inputmode')).toBe('numeric');
      expect(c.getAttribute('maxlength')).toBe('1');
    }
  });

  it('uses autocomplete="one-time-code" on the first cell for SMS / email autofill', () => {
    render(<Harness />);
    const all = cells();
    expect(all[0].getAttribute('autocomplete')).toBe('one-time-code');
  });
});

// ─── Typing + auto-advance ──────────────────────────────────────────────────

describe('OtpInput — typing', () => {
  it('advances focus to the next cell after a digit is typed', () => {
    render(<Harness />);
    const [c0, c1] = cells();
    c0.focus();
    fireEvent.change(c0, { target: { value: '1' } });
    expect(document.activeElement).toBe(c1);
  });

  it('strips non-digit characters', () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.change(cells()[0], { target: { value: 'a' } });
    expect(spy).toHaveBeenLastCalledWith('');
  });

  it('fires onComplete exactly when six digits have been entered', () => {
    const completeSpy = vi.fn();
    render(<Harness onCompleteSpy={completeSpy} />);
    const all = cells();
    for (let i = 0; i < 5; i++) {
      fireEvent.change(all[i], { target: { value: String(i + 1) } });
      expect(completeSpy).not.toHaveBeenCalled();
    }
    fireEvent.change(all[5], { target: { value: '6' } });
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledWith('123456');
  });
});

// ─── Backspace ──────────────────────────────────────────────────────────────

describe('OtpInput — backspace', () => {
  it('moves focus back and clears the previous cell when current is empty', () => {
    render(<Harness />);
    const all = cells();
    // Fill cells 0 and 1.
    fireEvent.change(all[0], { target: { value: '1' } });
    fireEvent.change(all[1], { target: { value: '2' } });
    // Focus cell 2 (empty) and backspace.
    all[2].focus();
    fireEvent.keyDown(all[2], { key: 'Backspace' });
    expect(document.activeElement).toBe(all[1]);
    expect(all[1].value).toBe('');
  });
});

// ─── Paste ──────────────────────────────────────────────────────────────────

describe('OtpInput — paste', () => {
  it('distributes a 6-digit paste across all six cells in one event', () => {
    const spy = vi.fn();
    render(<Harness onCompleteSpy={spy} />);
    const all = cells();
    fireEvent.paste(all[0], {
      clipboardData: { getData: () => '123456' },
    });
    expect(all[0].value).toBe('1');
    expect(all[5].value).toBe('6');
    expect(spy).toHaveBeenCalledWith('123456');
  });

  it('strips non-digits from the pasted string', () => {
    render(<Harness />);
    const all = cells();
    fireEvent.paste(all[0], {
      clipboardData: { getData: () => '1-2-3-4-5-6' },
    });
    expect(all[0].value).toBe('1');
    expect(all[5].value).toBe('6');
  });

  it('truncates pastes longer than 6 digits', () => {
    render(<Harness />);
    const all = cells();
    fireEvent.paste(all[0], {
      clipboardData: { getData: () => '12345678' },
    });
    expect(all[0].value).toBe('1');
    expect(all[5].value).toBe('6');
  });
});
