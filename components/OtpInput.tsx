'use client';

import { useEffect, useRef, useState } from 'react';

// ─── OtpInput ────────────────────────────────────────────────────────────
//
// SEGMENTED-LOOK OTP entry backed by ONE real input. Rewritten
// 2026-06-21 to combine the two prior designs' strengths:
//
//   • 6 visual cells (segmented look the patient expects).
//   • 1 real <input> underneath — the only thing the browser and OS
//     interact with for paste + SMS autofill, so neither flow can
//     break the way it did on the multi-cell design.
//
// How it works:
//
//   • A single invisible-but-focusable <input> is absolutely positioned
//     over the visual cell row. The container's onClick focuses it.
//   • The cells are pure presentational divs driven by the controlled
//     `value` prop. Each renders one character of `value[i]` plus an
//     active-cell caret on the next-to-be-typed slot.
//   • Paste + SMS autofill both write into the single input → onChange
//     fires once with the full code → all 6 cells render filled
//     simultaneously. No truncation race, no per-cell distribution.
//   • Backspace, arrow keys, IME — handled natively by the single
//     input, no custom key handlers required.
//
// API kept stable so the consumers (PhoneOtpStep + VerifyEmailForm)
// pick this up with zero call-site changes.

const LENGTH = 6;

type Props = {
  value:        string;             // 0..LENGTH digits
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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    // Run once on mount only — focusing again during keystrokes
    // would steal the OS autofill suggestion bar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Single change handler — every input source funnels here ────────
  // Typing one digit, paste of "482165", paste of "Your code is 482165",
  // OS SMS autofill of "482165". All arrive as a ChangeEvent with the
  // full new value in e.target.value. Strip non-digits + slice to
  // LENGTH covers them all uniformly.
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const digits = e.target.value.replace(/\D/g, '').slice(0, LENGTH);
    onChange(digits);
    if (digits.length === LENGTH) onComplete?.(digits);
  }

  // ── Paste handler — REPLACE, not append ────────────────────────────
  // Default browser paste inserts at cursor position; if the field
  // already contains "12" and the user pastes "482165" the post-paste
  // value would be "12482165" — strip+slice would yield "124821",
  // losing the last two real digits of the actual code. Override:
  // preventDefault, parse the clipboard digits, replace the field
  // entirely. Matches user intent — "paste a code" means "use this".
  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    const digits = text.replace(/\D/g, '').slice(0, LENGTH);
    if (digits.length === 0) return;
    e.preventDefault();
    onChange(digits);
    if (digits.length === LENGTH) onComplete?.(digits);
  }

  // The cells render from the current value. Active cell is the slot
  // we expect the next digit in — useful when the patient is partway
  // through typing OR when the field is freshly focused and empty.
  const activeIndex = focused && value.length < LENGTH ? value.length : -1;

  return (
    <div
      className="relative inline-flex w-full max-w-sm mx-auto"
      role="group"
      aria-label="6-digit verification code"
      onClick={() => inputRef.current?.focus()}
    >
      {/* ── Visual cell row (purely presentational; driven by value) ── */}
      <div className="flex gap-2 sm:gap-3 w-full justify-center" aria-hidden="true">
        {Array.from({ length: LENGTH }).map((_, i) => {
          const ch       = value[i] ?? '';
          const isActive = i === activeIndex;
          const filled   = ch !== '';

          const cellClass =
            'relative flex items-center justify-center '
            + 'h-14 w-12 sm:h-16 sm:w-14 rounded-xl border-2 '
            + 'text-2xl sm:text-3xl font-mono tabular-nums '
            + 'transition-colors '
            + (hasError
                ? 'border-red-400 bg-red-50 text-red-700'
              : filled
                ? 'border-[#15A89E] bg-white text-[#0F1F3A]'
              : isActive
                ? 'border-[#15A89E] bg-white ring-4 ring-[#15A89E]/15'
                : 'border-[#D8DEE8] bg-white');

          return (
            <div
              key={i}
              data-testid={`otp-cell-${i}`}
              className={cellClass}
            >
              {filled ? (
                ch
              ) : isActive ? (
                // Caret-like indicator on the next-to-be-typed cell.
                // motion-safe keeps this respectful of reduced-motion.
                <span
                  className="block h-7 sm:h-8 w-px bg-[#15A89E] motion-safe:animate-pulse"
                  aria-hidden="true"
                />
              ) : (
                <span className="text-[#D8DEE8] text-2xl leading-none">•</span>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Real input — invisible, focusable, absolutely positioned ──
          THIS is the thing the OS / clipboard / autofill writes into.
          opacity-0 keeps it invisible; the cells above are what the
          user sees. caret-color: transparent suppresses the native
          caret blink (the cell-row draws its own active-cell caret).
          aria-label is the accessibility surface (cells are
          aria-hidden so screen readers see exactly one input). */}
      <input
        id={`${idPrefix}-input`}
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        // maxLength={6} — single input, the autofill payload is
        // exactly 6 digits. This is the constraint the user requested
        // and what most carriers / OS autofill expect.
        maxLength={LENGTH}
        pattern="\d{6}"
        name="otp"
        value={value}
        disabled={disabled}
        aria-invalid={hasError}
        aria-label="6-digit verification code"
        onChange={handleChange}
        onPaste={handlePaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        // Absolute fill: every tap inside the container area hits the
        // input. Tapping any visual cell focuses the input, so a long-
        // press anywhere brings up the OS autofill suggestion bar.
        className="absolute inset-0 w-full h-full opacity-0 cursor-text disabled:cursor-not-allowed"
        // Native caret hidden — cell-row renders its own. Without this
        // the native caret would draw at the start of the value in
        // the absolute-positioned overlay, peeking through cells.
        style={{ caretColor: 'transparent' }}
      />
    </div>
  );
}

export const OTP_LENGTH = LENGTH;
