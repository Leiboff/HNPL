'use client';

import { useEffect, useRef } from 'react';

// ─── OtpInput ────────────────────────────────────────────────────────────────
//
// Six-cell numeric code entry. One <input> per digit so keyboard /
// screen-reader behaviour stays predictable and so each cell can hold focus
// for its own digit.
//
// Behaviour:
//   • Typing a digit advances focus to the next cell.
//   • Backspace on an empty cell moves focus back and clears the previous.
//   • Arrow Left / Right move focus without changing the value.
//   • Pasting a 6-digit string fills all six cells in one go.
//   • Non-digits are filtered out.
//   • When the value reaches LENGTH digits, `onComplete` fires once.

const LENGTH = 6;

type Props = {
  value:        string;             // string of 0..LENGTH digits
  onChange:     (next: string) => void;
  onComplete?:  (full:  string) => void;
  disabled?:    boolean;
  hasError?:    boolean;
  autoFocus?:   boolean;
  idPrefix?:    string;
};

export default function OtpInput({
  value,
  onChange,
  onComplete,
  disabled  = false,
  hasError  = false,
  autoFocus = false,
  idPrefix  = 'otp',
}: Props) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  // Auto-focus the first empty cell on mount when requested.
  useEffect(() => {
    if (!autoFocus) return;
    const firstEmpty = Math.min(value.length, LENGTH - 1);
    refs.current[firstEmpty]?.focus();
    // Run once on mount only — re-focusing on every value change steals
    // focus during keystrokes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setDigit(index: number, digit: string) {
    // Build the next string with one digit at `index`, padding with '' for
    // missing cells. Then trim trailing '' so onComplete fires only when
    // we have a contiguous N-digit value.
    const chars = Array.from({ length: LENGTH }, (_, i) => value[i] ?? '');
    chars[index] = digit;
    const next = chars.join('');
    const trimmed = next.replace(/\s/g, '');
    onChange(trimmed);
    if (trimmed.length === LENGTH && /^\d{6}$/.test(trimmed)) onComplete?.(trimmed);
  }

  function handleChange(index: number, e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    // Strip non-digits and take only the last digit typed (covers the case
    // where IME / mobile autofill drops multiple characters at once).
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 0) {
      setDigit(index, '');
      return;
    }
    if (digits.length === 1) {
      setDigit(index, digits);
      // Advance focus.
      if (index < LENGTH - 1) refs.current[index + 1]?.focus();
      return;
    }
    // Multi-digit input — treat as a paste-into-cell. Distribute across cells.
    distribute(digits, index);
  }

  function distribute(digits: string, startIndex: number) {
    const chars = Array.from({ length: LENGTH }, (_, i) => value[i] ?? '');
    let i = startIndex;
    for (const d of digits) {
      if (i >= LENGTH) break;
      chars[i++] = d;
    }
    const next = chars.join('').replace(/\s/g, '');
    onChange(next);
    const lastFilled = Math.min(startIndex + digits.length, LENGTH) - 1;
    refs.current[Math.max(lastFilled, 0)]?.focus();
    if (next.length === LENGTH && /^\d{6}$/.test(next)) onComplete?.(next);
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      if (!(value[index] ?? '')) {
        // Empty cell → move back and clear the previous cell.
        if (index > 0) {
          e.preventDefault();
          setDigit(index - 1, '');
          refs.current[index - 1]?.focus();
        }
      }
      return;
    }
    if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      refs.current[index - 1]?.focus();
      return;
    }
    if (e.key === 'ArrowRight' && index < LENGTH - 1) {
      e.preventDefault();
      refs.current[index + 1]?.focus();
      return;
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    const digits = text.replace(/\D/g, '').slice(0, LENGTH);
    if (digits.length === 0) return;
    e.preventDefault();
    distribute(digits, 0);
  }

  return (
    <div className="flex gap-2 justify-center" role="group" aria-label="6-digit verification code">
      {Array.from({ length: LENGTH }).map((_, i) => (
        <input
          key={i}
          id={`${idPrefix}-${i}`}
          ref={(el) => { refs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          value={value[i] ?? ''}
          disabled={disabled}
          aria-invalid={hasError}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={i === 0 ? handlePaste : undefined}
          className={
            'h-14 w-12 sm:h-16 sm:w-14 text-center text-xl font-semibold rounded-lg border-2 outline-none transition-all '
            + (hasError
              ? 'border-red-400 bg-red-50 text-red-700 focus:ring-2 focus:ring-red-200'
              : 'border-gray-300 bg-white text-gray-900 focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20')
            + (disabled ? ' opacity-60 cursor-not-allowed' : '')
          }
        />
      ))}
    </div>
  );
}

export const OTP_LENGTH = LENGTH;
