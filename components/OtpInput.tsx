'use client';

import { useEffect, useRef } from 'react';

// ─── OtpInput ────────────────────────────────────────────────────────────
//
// SINGLE-FIELD numeric OTP entry (rewritten from the previous 6-cell
// implementation, 2026-06-20). The six-cell design fought against:
//
//   • OS-level SMS autofill on iOS Safari + Android Chrome, which sets
//     `input.value` programmatically. A multi-cell field with
//     maxLength=1 truncates the autofilled code to the first digit;
//     this is the documented failure mode (Apple HIG + Google's auth
//     guidance both call out single-field as the correct pattern).
//   • Paste anywhere except the first cell — `onPaste` was attached
//     only to cell 0, so a paste into any other cell hit
//     maxLength=1 and lost five digits.
//
// A single text field with `autoComplete="one-time-code"`,
// `inputMode="numeric"`, and a generous letter-spacing visual:
//
//   • Receives the full SMS autofill payload in one onChange event
//     (no truncation race).
//   • Receives the full clipboard text on paste (browser default
//     behaviour fills the field); our handler strips non-digit chars
//     and truncates to LENGTH so "Your code is 482165" pastes as
//     "482165" cleanly from an email body.
//   • Reads visually as a deliberate OTP field via center-aligned
//     monospaced font with letter-spacing — does NOT look like a
//     fallback.
//
// Used by both /verify-email (email OTP, paste-driven) and the phone
// OTP step (SMS autofill-driven). Same component, same behaviour app-
// wide. API kept stable so existing call sites are unchanged.

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
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.focus();
    // Run once on mount. Re-focusing on value change would steal focus
    // from the OS autofill suggestion bar, which is the opposite of
    // what we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Single-path digit handler ──────────────────────────────────────
  // Every input source — typing, paste, OS SMS autofill — arrives
  // here as one ChangeEvent. Strip non-digits + truncate to LENGTH,
  // emit. No per-source branching needed; the design is the fix.
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const digits = e.target.value.replace(/\D/g, '').slice(0, LENGTH);
    onChange(digits);
    if (digits.length === LENGTH) onComplete?.(digits);
  }

  // ── Paste handler (explicit replace, not append) ───────────────────
  // The default browser paste INSERTS the clipboard text at the
  // cursor position. If `value` is already "12" and the user pastes
  // "482165", the post-default value would be "12482165" — our
  // change-handler would strip + truncate to "124821", which is
  // wrong (lost two digits of the actual code).
  //
  // Explicit handler: prevent default, take the clipboard digits, and
  // REPLACE the field's value entirely. Matches user intent — pasting
  // a code means "use this code", not "append this to what I typed".
  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    const digits = text.replace(/\D/g, '').slice(0, LENGTH);
    if (digits.length === 0) return;
    e.preventDefault();
    onChange(digits);
    if (digits.length === LENGTH) onComplete?.(digits);
  }

  return (
    <div className="flex justify-center" role="group" aria-label="6-digit verification code">
      <input
        id={`${idPrefix}-input`}
        ref={ref}
        // type="text" not "number" — number inputs strip leading zeros
        // and on iOS render a non-OTP-friendly keypad. inputMode handles
        // the numeric keyboard cleanly without those side-effects.
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        // maxLength generous — NOT set to 6. iOS Safari has been
        // observed to refuse SMS autofill writes when the underlying
        // input is maxLength=6, because the autofill payload technically
        // arrives via an input event that wants to set the full string
        // before any truncation. We do the LENGTH cap in handleChange
        // after the value has reached us.
        maxLength={32}
        pattern="\d{6}"
        // Names that nudge browsers + password managers to recognise
        // this as an OTP field. "name=otp" + autocomplete="one-time-code"
        // is the combination Mozilla + Apple docs cite.
        name="otp"
        value={value}
        disabled={disabled}
        aria-invalid={hasError}
        aria-label="6-digit verification code"
        onChange={handleChange}
        onPaste={handlePaste}
        placeholder="• • • • • •"
        className={
          'h-14 sm:h-16 w-full max-w-[18ch] text-center font-mono '
          + 'text-2xl sm:text-3xl tabular-nums tracking-[0.6em] indent-[0.6em] '
          + 'rounded-xl border-2 outline-none transition-all '
          + (hasError
            ? 'border-red-400 bg-red-50 text-red-700 focus:ring-2 focus:ring-red-200 placeholder:text-red-300'
            : 'border-gray-300 bg-white text-gray-900 focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20 placeholder:text-gray-300')
          + (disabled ? ' opacity-60 cursor-not-allowed' : '')
        }
      />
    </div>
  );
}

export const OTP_LENGTH = LENGTH;
