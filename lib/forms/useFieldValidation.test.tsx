import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useMemo, useState } from 'react';
import {
  useFieldValidation,
  type FieldsSchema,
} from './useFieldValidation';

// ─── Test harness ────────────────────────────────────────────────────────────
//
// A minimal form that drives the hook with two fields:
//   • name      — always-on validation (required).
//   • saId      — suppresses live errors until digits >= 13. Stand-in for
//                 the real SA ID gate; we don't need full Luhn here.
//
// The test surface exposes:
//   • role=textbox per field (with the label name) for typing/blur
//   • An "Invalid" line per field for assertion-by-text
//   • An onSubmit button that calls validateAll and renders the first
//     invalid field name + ok status

type Values = { name: string; saId: string };

function Harness({ onSubmitResult }: { onSubmitResult?: (r: { ok: boolean; firstInvalid: keyof Values | null }) => void }) {
  const [values, setValues] = useState<Values>({ name: '', saId: '' });

  const schema = useMemo<FieldsSchema<Values>>(() => ({
    name: { validate: (v) => v.name.trim() ? null : 'Name is required.' },
    saId: {
      validate: (v) => {
        if (v.saId.length === 0)  return 'SA ID is required.';
        if (v.saId.length !== 13) return 'SA ID must be 13 digits.';
        if (v.saId === '0000000000000') return 'SA ID checksum failed.';
        return null;
      },
      suppressLive: (v) => v.saId.length < 13,
    },
  }), []);

  const { errors, handleBlur, validateAll } = useFieldValidation(values, schema);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const r = validateAll();
        onSubmitResult?.(r);
      }}
    >
      <label htmlFor="name">name</label>
      <input
        id="name"
        value={values.name}
        onChange={(e) => setValues(v => ({ ...v, name: e.target.value }))}
        onBlur={() => handleBlur('name')}
      />
      <div data-testid="name-error">{errors.name ?? ''}</div>

      <label htmlFor="saId">saId</label>
      <input
        id="saId"
        value={values.saId}
        onChange={(e) => setValues(v => ({ ...v, saId: e.target.value }))}
        onBlur={() => handleBlur('saId')}
      />
      <div data-testid="saId-error">{errors.saId ?? ''}</div>

      <button type="submit">Submit</button>
    </form>
  );
}

// ─── Live-mode behaviour ─────────────────────────────────────────────────────

describe('useFieldValidation — touched/blur semantics', () => {
  it('does NOT show an error before the field has been touched', () => {
    render(<Harness />);
    expect(screen.getByTestId('name-error').textContent).toBe('');
  });

  it('shows the error on blur of an empty required field', () => {
    render(<Harness />);
    const input = screen.getByLabelText('name');
    fireEvent.blur(input);
    expect(screen.getByTestId('name-error').textContent).toBe('Name is required.');
  });

  it('clears the error on keystroke once the field becomes valid', () => {
    render(<Harness />);
    const input = screen.getByLabelText('name');
    fireEvent.blur(input);
    expect(screen.getByTestId('name-error').textContent).toBe('Name is required.');

    fireEvent.change(input, { target: { value: 'Jane' } });
    expect(screen.getByTestId('name-error').textContent).toBe('');
  });

  it('does not re-emit the error if the user empties the field WITHOUT blurring after a fresh render', () => {
    // (Sanity check that once touched, the error returns when the field
    //  becomes invalid again — re-validation runs on every keystroke once
    //  the field has been touched.)
    render(<Harness />);
    const input = screen.getByLabelText('name');
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: 'Jane' } });
    expect(screen.getByTestId('name-error').textContent).toBe('');
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('name-error').textContent).toBe('Name is required.');
  });
});

// ─── suppressLive (SA ID under 13 digits) ────────────────────────────────────

describe('useFieldValidation — suppressLive gate', () => {
  it('suppresses error display while value is under the threshold, even after blur', () => {
    render(<Harness />);
    const saId = screen.getByLabelText('saId');
    fireEvent.change(saId, { target: { value: '12345' } });
    fireEvent.blur(saId);
    // Under 13 digits — live error suppressed.
    expect(screen.getByTestId('saId-error').textContent).toBe('');
  });

  it('shows the validator error at the threshold (13 digits, invalid value)', () => {
    render(<Harness />);
    const saId = screen.getByLabelText('saId');
    fireEvent.change(saId, { target: { value: '0000000000000' } });
    fireEvent.blur(saId);
    expect(screen.getByTestId('saId-error').textContent).toBe('SA ID checksum failed.');
  });

  it('clears the threshold error once the user backspaces below 13 digits', () => {
    render(<Harness />);
    const saId = screen.getByLabelText('saId');
    fireEvent.change(saId, { target: { value: '0000000000000' } });
    fireEvent.blur(saId);
    expect(screen.getByTestId('saId-error').textContent).toBe('SA ID checksum failed.');
    fireEvent.change(saId, { target: { value: '000000000000' } });   // 12 chars
    expect(screen.getByTestId('saId-error').textContent).toBe('');
  });
});

// ─── Submit pass ─────────────────────────────────────────────────────────────

describe('useFieldValidation — validateAll() on submit', () => {
  it('returns ok=false and the first invalid field in declaration order', () => {
    const resultSpy = vi.fn();
    render(<Harness onSubmitResult={resultSpy} />);
    fireEvent.click(screen.getByText('Submit'));
    expect(resultSpy).toHaveBeenCalledWith({ ok: false, firstInvalid: 'name' });
  });

  it('marks every field touched on submit (so errors show even where the user never blurred)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Submit'));
    expect(screen.getByTestId('name-error').textContent).toBe('Name is required.');
    // saId error shows even though the user never touched the field, and
    // even though the value is empty (under the suppressLive threshold).
    // validateAll() ignores suppressLive on purpose — submit is the backstop.
    expect(screen.getByTestId('saId-error').textContent).toBe('SA ID is required.');
  });

  it('returns ok=true once all fields are valid', () => {
    const resultSpy = vi.fn();
    render(<Harness onSubmitResult={resultSpy} />);
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText('saId'), { target: { value: '1234567890123' } });
    fireEvent.click(screen.getByText('Submit'));
    expect(resultSpy).toHaveBeenLastCalledWith({ ok: true, firstInvalid: null });
  });

  it('walks fields in declaration order — name comes before saId', () => {
    const resultSpy = vi.fn();
    render(<Harness onSubmitResult={resultSpy} />);
    // Fill saId only — name is still empty.
    fireEvent.change(screen.getByLabelText('saId'), { target: { value: '1234567890123' } });
    fireEvent.click(screen.getByText('Submit'));
    expect(resultSpy).toHaveBeenLastCalledWith({ ok: false, firstInvalid: 'name' });

    // Fill name, empty saId — first invalid flips to saId.
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText('saId'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Submit'));
    expect(resultSpy).toHaveBeenLastCalledWith({ ok: false, firstInvalid: 'saId' });
  });
});
