'use client';

import { useState } from 'react';

// ─── PinInput — masked numeric PIN field with a reveal toggle ─────────────
//
// No password-visibility-toggle pattern existed anywhere else in the
// codebase (checked login, signup, update-password, and the checkout
// password-set screen — all plain type="password", no toggle), so this
// is a new, small, reusable component rather than a one-off inline
// field. Shared by BOTH PIN-entry surfaces: the manager's Set/Reset PIN
// form (DeviceAdminView) and the till kiosk's own unlock screen
// (TillShell) — "anywhere it's entered" per the UX spec.
//
// Reveal state is controllable (visible/onVisibleChange) so a caller
// can force it open right after generating a PIN (the manager needs to
// actually read it to note it down); omitted, it manages its own
// internal toggle — the standard uncontrolled default.

const EyeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <path d="M1 1l22 22" />
  </svg>
);

export type PinInputProps = {
  id?:              string;
  value:            string;
  onChange:         (value: string) => void;
  maxLength?:       number;
  placeholder?:     string;
  disabled?:        boolean;
  className?:       string;
  testId?:          string;
  /** Controlled reveal state — omit to manage internally. */
  visible?:         boolean;
  onVisibleChange?: (visible: boolean) => void;
};

export default function PinInput({
  id,
  value,
  onChange,
  maxLength = 6,
  placeholder,
  disabled = false,
  className = '',
  testId,
  visible: visibleProp,
  onVisibleChange,
}: PinInputProps) {
  const [internalVisible, setInternalVisible] = useState(false);
  const visible = visibleProp ?? internalVisible;

  function toggle() {
    const next = !visible;
    if (onVisibleChange) onVisibleChange(next);
    else setInternalVisible(next);
  }

  return (
    <div className="relative">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        inputMode="numeric"
        maxLength={maxLength}
        autoComplete="off"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        placeholder={placeholder}
        data-testid={testId}
        className={`w-full pr-10 rounded-lg border border-gray-300 px-3.5 py-2.5 font-mono tracking-widest text-gray-900 disabled:opacity-60 ${className}`}
      />
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-label={visible ? 'Hide PIN' : 'Show PIN'}
        data-testid={testId ? `${testId}-toggle` : undefined}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 disabled:opacity-60"
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}
