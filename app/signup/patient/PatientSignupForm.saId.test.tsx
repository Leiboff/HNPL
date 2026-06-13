import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The form is a client component that calls a server action on submit.
// We don't exercise submit here — only the SA ID field's display rules —
// but vitest still imports the actions module while resolving the form,
// so we stub it. The server-action module top-of-file uses `next/headers`
// and `@supabase/supabase-js` which would otherwise fail to resolve under
// happy-dom.
vi.mock('./actions', () => ({
  signUpPatient: vi.fn(async () => ({ error: null, success: true })),
}));

import PatientSignupForm from './PatientSignupForm';

// ─── SA ID synthesiser (mirrors lib/validation/saId.test.ts) ─────────────────
//
// We need a Luhn-valid, 18+ ID to assert "error clears on keystroke once
// the value becomes valid." Built locally so the test stays isolated from
// internal helpers in the validator's own test file.

function synthLuhn(first12: string): string {
  let sum = 0;
  let doubleIt = true;
  for (let i = first12.length - 1; i >= 0; i--) {
    let d = first12.charCodeAt(i) - 48;
    if (doubleIt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    doubleIt = !doubleIt;
  }
  return String((10 - (sum % 10)) % 10);
}

function validAdultSaId(): string {
  // 1995-06-15, female, citizenship 0 — comfortably 18+ in 2026.
  const first12 = '95' + '06' + '15' + '0123' + '0' + '8';
  return first12 + synthLuhn(first12);
}

const GENERIC = 'Please enter a valid SA ID number.';

function renderForm() {
  return render(<PatientSignupForm invitation={null} token={null} />);
}

function getSaIdInput(): HTMLInputElement {
  // Field id is "patient-saIdNumber"; we query by id rather than label so
  // the test isn't coupled to label text.
  const el = document.getElementById('patient-saIdNumber');
  if (!el) throw new Error('SA ID input not found in DOM');
  return el as HTMLInputElement;
}

// ─── No digit-count hint, ever ───────────────────────────────────────────────

describe('PatientSignupForm SA ID — no digit-count hint at any value', () => {
  it.each([
    '',
    '1',
    '123',
    '123456789',
    '000000000000',     // 12 digits
    '0000000000000',    // 13 digits, Luhn fail
    '1234567890123',
  ])('renders no "N/13 digits" hint for value=%s', (value) => {
    renderForm();
    const input = getSaIdInput();
    fireEvent.change(input, { target: { value } });
    // No literal count, no fraction, no trailing "digits" hint.
    expect(document.body.textContent).not.toMatch(/\d+\s*\/\s*13\s*digits/i);
    expect(document.body.textContent).not.toMatch(/\b\d+\/13\b/);
  });

  it('renders no digit-count hint after blurring an empty field', () => {
    renderForm();
    fireEvent.blur(getSaIdInput());
    expect(document.body.textContent).not.toMatch(/\d+\s*\/\s*13/);
  });
});

// ─── Blur-not-keystroke first-show timing ───────────────────────────────────

describe('PatientSignupForm SA ID — first-show timing is blur, not keystroke', () => {
  it('shows no message before the field has been touched', () => {
    renderForm();
    expect(screen.queryByText(GENERIC)).toBeNull();
  });

  it('shows no message while the user is typing an invalid value without blur', () => {
    renderForm();
    const input = getSaIdInput();
    fireEvent.change(input, { target: { value: '1' } });
    expect(screen.queryByText(GENERIC)).toBeNull();
    fireEvent.change(input, { target: { value: '12345' } });
    expect(screen.queryByText(GENERIC)).toBeNull();
    fireEvent.change(input, { target: { value: '0000000000000' } });
    expect(screen.queryByText(GENERIC)).toBeNull();
  });

  it('shows the generic message on blur of an empty field', () => {
    renderForm();
    fireEvent.blur(getSaIdInput());
    expect(screen.getByText(GENERIC)).toBeInTheDocument();
  });

  it('shows the generic message on blur of a partial (<13 digit) field', () => {
    renderForm();
    const input = getSaIdInput();
    fireEvent.change(input, { target: { value: '12345' } });
    fireEvent.blur(input);
    expect(screen.getByText(GENERIC)).toBeInTheDocument();
  });

  it('shows the generic message on blur of a 13-digit Luhn-failing field', () => {
    renderForm();
    const input = getSaIdInput();
    fireEvent.change(input, { target: { value: '0000000000000' } });
    fireEvent.blur(input);
    expect(screen.getByText(GENERIC)).toBeInTheDocument();
  });
});

// ─── Single message regardless of WHY it's invalid ───────────────────────────

describe('PatientSignupForm SA ID — single generic message, no internal reason codes leaked', () => {
  // For each invalid input (different internal reason: length / format /
  // date / citizenship / checksum), only the generic message renders.
  it.each([
    ['empty',         ''],
    ['short',         '12345'],
    ['non-digits',    'ABCDEFGHIJKLM'],
    ['bad-date',      '9913310000088'],   // month=13, day=31
    ['bad-citizen',   '9501010000388'],   // citizenship digit "3"
    ['luhn-fail',     '0000000000000'],
  ])('shows ONLY the generic message for %s', (_label, value) => {
    renderForm();
    const input = getSaIdInput();
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);

    // The generic message is rendered exactly once.
    expect(screen.getAllByText(GENERIC).length).toBe(1);

    // None of the internal reason-specific strings appear.
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/13 digits/);
    expect(body).not.toMatch(/check digit/);
    expect(body).not.toMatch(/citizenship/i);
    expect(body).not.toMatch(/calendar date/);
    expect(body).not.toMatch(/only digits/);
    expect(body).not.toMatch(/check.*doesn't match/i);
  });
});

// ─── Re-validate on keystroke once in error state ────────────────────────────

describe('PatientSignupForm SA ID — keystroke-clears once error is showing', () => {
  it('clears the error the moment the value becomes a valid 18+ SA ID', () => {
    renderForm();
    const input = getSaIdInput();
    fireEvent.change(input, { target: { value: '0000000000000' } });
    fireEvent.blur(input);
    expect(screen.getByText(GENERIC)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: validAdultSaId() } });
    expect(screen.queryByText(GENERIC)).toBeNull();
  });

  it('keeps the error visible as the user backspaces toward an empty value', () => {
    renderForm();
    const input = getSaIdInput();
    fireEvent.change(input, { target: { value: '0000000000000' } });
    fireEvent.blur(input);
    expect(screen.getByText(GENERIC)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '000000000000' } });   // 12 chars
    // Still invalid — message stays. We collapsed all reasons to one
    // message, so partial input on a touched field continues to show it.
    expect(screen.getByText(GENERIC)).toBeInTheDocument();
  });
});
