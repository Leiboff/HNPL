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

  it('strips non-digit characters on input', () => {
    const onChange = vi.fn();
    render(<PinInput value="" onChange={onChange} testId="pin" />);
    fireEvent.change(screen.getByTestId('pin'), { target: { value: '12a3b4' } });
    expect(onChange).toHaveBeenCalledWith('1234');
  });
});
