import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import OtpInput, { OTP_LENGTH } from './OtpInput';

// ─── OtpInput — single-field paste + autofill contract ──────────────────
//
// Rewritten from a 6-cell design on 2026-06-20 because the multi-cell
// pattern broke both OS SMS autofill (one-time-code) and full-code
// paste. The new design is a single text input with autoComplete=
// "one-time-code" + inputMode="numeric" + generous letter-spacing.
//
// These tests pin the three properties the new design exists to fix:
//
//   1. Typing a digit at a time emits onChange after each digit and
//      fires onComplete once on the 6th.
//   2. Pasting a 6-digit string (formatted or not) lands all digits
//      AND fires onComplete. Replaces the existing value, doesn't
//      append (intent of "paste a code" = "use this code").
//   3. OS SMS autofill — modeled as a programmatic value-set on the
//      single field — flows through the same onChange handler with no
//      maxLength=1 truncation race. This is the path that USED TO
//      collapse to a single digit on the 6-cell design.

// ─── Harness ────────────────────────────────────────────────────────────────

function Harness({
  onChangeSpy,
  onCompleteSpy,
  initial = '',
}: {
  onChangeSpy?:   (s: string) => void;
  onCompleteSpy?: (s: string) => void;
  initial?:       string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <OtpInput
      value={value}
      onChange={(s) => { setValue(s); onChangeSpy?.(s); }}
      onComplete={onCompleteSpy}
    />
  );
}

function getInput(): HTMLInputElement {
  return document.getElementById('otp-input') as HTMLInputElement;
}

// ─── Constants ──────────────────────────────────────────────────────────────

describe('OTP_LENGTH', () => {
  it('is exactly 6 (matches Supabase dashboard OTP length + carrier SMS body)', () => {
    expect(OTP_LENGTH).toBe(6);
  });
});

// ─── Rendering (single-field, autofill-critical attributes) ─────────────────

describe('OtpInput — render', () => {
  it('renders exactly ONE input (not six cells)', () => {
    const { container } = render(<Harness />);
    expect(container.querySelectorAll('input')).toHaveLength(1);
  });

  it('declares the autofill-critical attributes on the single input', () => {
    render(<Harness />);
    const input = getInput();
    expect(input.getAttribute('autocomplete')).toBe('one-time-code');
    expect(input.getAttribute('inputmode')).toBe('numeric');
    // type=text (NOT number) — number inputs strip leading zeros and
    // render the wrong soft keyboard on iOS.
    expect(input.getAttribute('type')).toBe('text');
  });

  it('maxLength on the element is GENEROUS, not 6 (avoids autofill truncation race)', () => {
    // iOS Safari has been observed to refuse SMS autofill writes when
    // the field has maxLength=6 — the autofill payload arrives via an
    // input event that wants to set the full string before any
    // truncation. We do the LENGTH cap inside handleChange instead.
    render(<Harness />);
    const max = Number(getInput().getAttribute('maxlength'));
    expect(max).toBeGreaterThan(OTP_LENGTH);
  });

  it('has name="otp" + pattern="\\d{6}" — nudges browsers / password managers to recognise the field', () => {
    render(<Harness />);
    const input = getInput();
    expect(input.getAttribute('name')).toBe('otp');
    expect(input.getAttribute('pattern')).toBe('\\d{6}');
  });
});

// ─── Typing — one digit at a time ──────────────────────────────────────────

describe('OtpInput — typing', () => {
  it('strips non-digit characters from a typed value', () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.change(getInput(), { target: { value: '4abc' } });
    expect(spy).toHaveBeenLastCalledWith('4');
  });

  it('fires onComplete exactly once when the value reaches 6 digits', () => {
    const completeSpy = vi.fn();
    render(<Harness onCompleteSpy={completeSpy} />);
    // Simulate progressive typing through a controlled input — each
    // change replaces the value with the latest typed-text.
    const sequence = ['4', '48', '482', '4821', '48216', '482165'];
    for (const next of sequence.slice(0, -1)) {
      fireEvent.change(getInput(), { target: { value: next } });
    }
    expect(completeSpy).not.toHaveBeenCalled();
    fireEvent.change(getInput(), { target: { value: sequence[sequence.length - 1] } });
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledWith('482165');
  });

  it('truncates to 6 digits when more arrive (e.g. fast paste through change)', () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.change(getInput(), { target: { value: '4821659999' } });
    expect(spy).toHaveBeenLastCalledWith('482165');
  });
});

// ─── Paste (the bug we're fixing) ──────────────────────────────────────────

describe('OtpInput — paste lands all 6 digits in one event', () => {
  it('pastes a clean 6-digit code into an empty field + fires onComplete', () => {
    const changeSpy = vi.fn();
    const completeSpy = vi.fn();
    render(<Harness onChangeSpy={changeSpy} onCompleteSpy={completeSpy} />);
    fireEvent.paste(getInput(), {
      clipboardData: { getData: () => '482165' },
    });
    expect(changeSpy).toHaveBeenCalledWith('482165');
    expect(completeSpy).toHaveBeenCalledWith('482165');
  });

  it('REPLACES the value (does not append) when pasted over existing digits', () => {
    // The previous default-browser path would have given "12482165"
    // and strip+truncate would have produced "124821" — losing two
    // real digits. Our explicit onPaste handler replaces entirely.
    const changeSpy = vi.fn();
    render(<Harness initial="12" onChangeSpy={changeSpy} />);
    fireEvent.paste(getInput(), {
      clipboardData: { getData: () => '482165' },
    });
    expect(changeSpy).toHaveBeenLastCalledWith('482165');
  });

  it('extracts digits from formatted text ("Your code is 482165")', () => {
    // Real-world copy from an email body. Strip-non-digits turns
    // formatted text into a clean code in the same handler path.
    const changeSpy = vi.fn();
    const completeSpy = vi.fn();
    render(<Harness onChangeSpy={changeSpy} onCompleteSpy={completeSpy} />);
    fireEvent.paste(getInput(), {
      clipboardData: { getData: () => 'Your code is 482165' },
    });
    expect(changeSpy).toHaveBeenCalledWith('482165');
    expect(completeSpy).toHaveBeenCalledWith('482165');
  });

  it('extracts digits from dashed text ("482-165")', () => {
    const changeSpy = vi.fn();
    render(<Harness onChangeSpy={changeSpy} />);
    fireEvent.paste(getInput(), {
      clipboardData: { getData: () => '482-165' },
    });
    expect(changeSpy).toHaveBeenCalledWith('482165');
  });

  it('is a no-op when the clipboard contains no digits', () => {
    const changeSpy = vi.fn();
    render(<Harness onChangeSpy={changeSpy} />);
    fireEvent.paste(getInput(), {
      clipboardData: { getData: () => 'hello there' },
    });
    expect(changeSpy).not.toHaveBeenCalled();
  });
});

// ─── OS SMS autofill — same path as paste ──────────────────────────────────

describe('OtpInput — OS SMS autofill model', () => {
  it('a programmatic full-value-set (autofill shape) emits the full code', () => {
    // iOS Safari + Android Chrome implement SMS autofill by setting
    // input.value and dispatching an input/change event with the full
    // code. happy-dom can't summon the real autofill, but a
    // fireEvent.change with the full value reproduces the SHAPE of
    // the event the browsers dispatch. On the old 6-cell design this
    // path lost five digits to maxLength=1; on the new single-field
    // design it flows straight through.
    const changeSpy = vi.fn();
    const completeSpy = vi.fn();
    render(<Harness onChangeSpy={changeSpy} onCompleteSpy={completeSpy} />);
    fireEvent.change(getInput(), { target: { value: '482165' } });
    expect(changeSpy).toHaveBeenCalledWith('482165');
    expect(completeSpy).toHaveBeenCalledWith('482165');
  });
});
