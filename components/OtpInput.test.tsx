import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import OtpInput, { OTP_LENGTH } from './OtpInput';

// ─── OtpInput — segmented-visual / single-input contract ────────────────
//
// Hybrid design (2026-06-21): ONE real <input> backed by 6 presentational
// cells. The cells make it look segmented; the single underlying input
// keeps OS SMS autofill + paste working end-to-end the way they
// couldn't on the earlier 6-input design.
//
// These tests pin three loops of the contract:
//
//   1. The DOM has exactly ONE <input> (so OS autofill + paste only
//      ever target one thing). Six aria-hidden cell divs render the
//      visual.
//   2. Typing / paste / autofill all reach the same change-handler
//      path: strip non-digits, slice to 6, emit. onComplete fires
//      once at length === 6.
//   3. Paste REPLACES rather than appends — pasting "482165" over
//      already-typed "12" yields "482165", not "124821".

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

function getCells(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-testid^="otp-cell-"]')) as HTMLElement[];
}

function cellDigits(container: HTMLElement): string {
  // Each cell renders either a digit OR a placeholder dot / caret.
  // Extract just the digit (if any) for assertion clarity.
  return getCells(container)
    .map((c) => c.textContent?.replace(/\s+/g, '').match(/\d/)?.[0] ?? '')
    .join('');
}

// ─── Constants ──────────────────────────────────────────────────────────────

describe('OTP_LENGTH', () => {
  it('is exactly 6 (Supabase OTP length + carrier SMS body)', () => {
    expect(OTP_LENGTH).toBe(6);
  });
});

// ─── Render (single input + 6 cells) ───────────────────────────────────────

describe('OtpInput — render', () => {
  it('renders exactly ONE <input> element (the autofill / paste target)', () => {
    const { container } = render(<Harness />);
    expect(container.querySelectorAll('input')).toHaveLength(1);
  });

  it('renders 6 presentational cells (the segmented visual)', () => {
    const { container } = render(<Harness />);
    expect(getCells(container)).toHaveLength(OTP_LENGTH);
  });

  it('cells row is aria-hidden — screen readers see only the single input', () => {
    const { container } = render(<Harness />);
    const cellsRow = container.querySelector('[aria-hidden="true"]');
    expect(cellsRow).not.toBeNull();
    // The input itself is NOT aria-hidden and carries the label.
    expect(getInput().getAttribute('aria-label')).toBe('6-digit verification code');
  });

  it('declares the autofill-critical attributes on the single input', () => {
    render(<Harness />);
    const input = getInput();
    expect(input.getAttribute('autocomplete')).toBe('one-time-code');
    expect(input.getAttribute('inputmode')).toBe('numeric');
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('name')).toBe('otp');
    expect(input.getAttribute('pattern')).toBe('\\d{6}');
    // maxLength=6 — single input, the autofill payload is exactly
    // 6 digits and fits without truncation (which is why the multi-
    // cell design's maxLength=1 broke autofill).
    expect(Number(input.getAttribute('maxlength'))).toBe(OTP_LENGTH);
  });

  it('the input is visually hidden but focusable (absolute, opacity-0)', () => {
    render(<Harness />);
    const input = getInput();
    // Class string carries opacity-0 + absolute layout. Checking
    // class presence rather than computed style avoids depending on
    // happy-dom resolving Tailwind.
    expect(input.className).toContain('opacity-0');
    expect(input.className).toContain('absolute');
    expect(input.disabled).toBe(false);
  });
});

// ─── Filled-cell rendering ─────────────────────────────────────────────────

describe('OtpInput — cells reflect the controlled value', () => {
  it('renders digits into their corresponding cells when value populates', () => {
    const { container } = render(<Harness initial="482" />);
    const cells = getCells(container);
    expect(cells[0].textContent).toContain('4');
    expect(cells[1].textContent).toContain('8');
    expect(cells[2].textContent).toContain('2');
    // Cells 3..5 are empty (no digit yet).
    for (let i = 3; i < OTP_LENGTH; i++) {
      expect(cells[i].textContent).not.toMatch(/\d/);
    }
  });

  it('all 6 cells fill from a single paste event (the fix this rewrite delivers)', () => {
    const onComplete = vi.fn();
    const { container } = render(<Harness onCompleteSpy={onComplete} />);
    fireEvent.paste(getInput(), {
      clipboardData: { getData: () => '482165' },
    });
    expect(cellDigits(container)).toBe('482165');
    expect(onComplete).toHaveBeenCalledWith('482165');
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
    const sequence = ['4', '48', '482', '4821', '48216', '482165'];
    for (const next of sequence.slice(0, -1)) {
      fireEvent.change(getInput(), { target: { value: next } });
    }
    expect(completeSpy).not.toHaveBeenCalled();
    fireEvent.change(getInput(), { target: { value: sequence[sequence.length - 1] } });
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledWith('482165');
  });
});

// ─── Paste (the load-bearing bug fix) ──────────────────────────────────────

describe('OtpInput — paste fills all 6 cells in one event', () => {
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
    const changeSpy = vi.fn();
    render(<Harness initial="12" onChangeSpy={changeSpy} />);
    fireEvent.paste(getInput(), {
      clipboardData: { getData: () => '482165' },
    });
    expect(changeSpy).toHaveBeenLastCalledWith('482165');
  });

  it('extracts digits from formatted text ("Your code is 482165")', () => {
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
  it('a programmatic full-value-set (the autofill shape) emits the full code AND fills all cells', () => {
    // iOS Safari + Android Chrome implement SMS autofill by setting
    // input.value and dispatching an input event with the full code.
    // On the segmented-single-input design that event reaches our
    // change handler with value="482165"; one render later, all six
    // cells reflect the digits.
    const changeSpy = vi.fn();
    const completeSpy = vi.fn();
    const { container } = render(<Harness onChangeSpy={changeSpy} onCompleteSpy={completeSpy} />);
    fireEvent.change(getInput(), { target: { value: '482165' } });
    expect(changeSpy).toHaveBeenCalledWith('482165');
    expect(completeSpy).toHaveBeenCalledWith('482165');
    expect(cellDigits(container)).toBe('482165');
  });
});
