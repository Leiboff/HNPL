import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PinInput from './PinInput';

// ─── PinInput — masked by default, reveal toggle works ─────────────────

describe('PinInput — masked by default with a working reveal toggle', () => {
  it('renders as type="password" by default (uncontrolled)', () => {
    render(<PinInput value="123456" onChange={() => {}} testId="pin" />);
    const input = screen.getByTestId('pin') as HTMLInputElement;
    expect(input.type).toBe('password');
  });

  it('clicking the toggle reveals the value (type="text"), clicking again hides it', () => {
    render(<PinInput value="123456" onChange={() => {}} testId="pin" />);
    const input  = screen.getByTestId('pin') as HTMLInputElement;
    const toggle = screen.getByTestId('pin-toggle');

    expect(input.type).toBe('password');
    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    fireEvent.click(toggle);
    expect(input.type).toBe('password');
  });

  it('the toggle button has an accessible label that reflects the current state', () => {
    render(<PinInput value="123456" onChange={() => {}} testId="pin" />);
    expect(screen.getByRole('button', { name: 'Show PIN' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('pin-toggle'));
    expect(screen.getByRole('button', { name: 'Hide PIN' })).toBeTruthy();
  });

  it('supports a controlled visible prop — caller can force it revealed', () => {
    const onVisibleChange = vi.fn();
    const { rerender } = render(
      <PinInput value="123456" onChange={() => {}} testId="pin" visible={false} onVisibleChange={onVisibleChange} />,
    );
    expect((screen.getByTestId('pin') as HTMLInputElement).type).toBe('password');

    rerender(<PinInput value="123456" onChange={() => {}} testId="pin" visible onVisibleChange={onVisibleChange} />);
    expect((screen.getByTestId('pin') as HTMLInputElement).type).toBe('text');

    fireEvent.click(screen.getByTestId('pin-toggle'));
    expect(onVisibleChange).toHaveBeenCalledWith(false);
  });

  // CONTRACT CHANGE (was: "strips non-digit characters on input").
  //
  // This component used to accept a mixed value and keep only its digits
  // ('12a3b4' -> '1234'). That silent partial-accept was the reveal-toggle
  // bug: a password manager autofilling a saved credential ('Passw6rd')
  // became a bare '6', which the masked field then showed as the real PIN.
  // See devices/pinReveal.test.tsx for the reproduction. A mixed value is
  // now rejected outright so React restores the previous good value, and
  // per-keystroke typing behaviour is unchanged (a stray letter is simply
  // ignored rather than committing a mangled value).
  it('rejects a mixed alphanumeric value outright instead of keeping only its digits', () => {
    const onChange = vi.fn();
    render(<PinInput value="" onChange={onChange} testId="pin" />);
    fireEvent.change(screen.getByTestId('pin'), { target: { value: '12a3b4' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('accepts a digit-only value, and trims surrounding whitespace from a paste', () => {
    const onChange = vi.fn();
    render(<PinInput value="" onChange={onChange} testId="pin" />);
    const input = screen.getByTestId('pin');

    fireEvent.change(input, { target: { value: '1234' } });
    expect(onChange).toHaveBeenCalledWith('1234');

    fireEvent.change(input, { target: { value: '  482913  ' } });
    expect(onChange).toHaveBeenCalledWith('482913');
  });

  it('allows clearing the field back to empty', () => {
    const onChange = vi.fn();
    render(<PinInput value="1234" onChange={onChange} testId="pin" />);
    fireEvent.change(screen.getByTestId('pin'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('rejects a digit-only value longer than maxLength (autofill is not length-capped by the attribute)', () => {
    const onChange = vi.fn();
    render(<PinInput value="" onChange={onChange} testId="pin" maxLength={6} />);
    fireEvent.change(screen.getByTestId('pin'), { target: { value: '1234567890123' } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
