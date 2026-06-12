import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import SalaryDayPicker, { pillLabel } from './SalaryDayPicker';

// Pure-function test for the label mapping (incl. "Last day" → 31).

describe('pillLabel', () => {
  it.each([
    [1,  '1st of the month'],
    [15, '15th'],
    [20, '20th'],
    [25, '25th'],
    [26, '26th'],
    [27, '27th'],
    [28, '28th'],
    [29, '29th'],
    [30, '30th'],
    [31, 'Last day'],
  ])('day %i → "%s"', (day, expected) => {
    expect(pillLabel(day)).toBe(expected);
  });

  it('handles teens correctly (no "1st"-style off-by-one for 11/12/13)', () => {
    expect(pillLabel(11)).toBe('11th');
    expect(pillLabel(12)).toBe('12th');
    expect(pillLabel(13)).toBe('13th');
    expect(pillLabel(21)).toBe('21st');
    expect(pillLabel(22)).toBe('22nd');
    expect(pillLabel(23)).toBe('23rd');
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Test harness: stateful wrapper so we can assert what the picker pushed
 * back via onChange and what re-renders look like under selection.
 */
function Harness({
  initial = null,
  currentDay = null,
  now,
  onChangeSpy,
}: {
  initial?: number | null;
  currentDay?: number | null;
  now?: Date;
  onChangeSpy?: (d: number) => void;
}) {
  const [value, setValue] = useState<number | null>(initial);
  return (
    <SalaryDayPicker
      value={value}
      onChange={(d) => { setValue(d); onChangeSpy?.(d); }}
      currentDay={currentDay}
      now={now}
    />
  );
}

// ─── Component tests ────────────────────────────────────────────────────────

describe('SalaryDayPicker — selection', () => {
  it('clicking an allowed pill fires onChange with the right day', async () => {
    const onChange = vi.fn();
    render(<Harness onChangeSpy={onChange} />);

    const userEv = userEvent.setup();
    await userEv.click(screen.getByRole('radio', { name: /^15th$/ }));
    expect(onChange).toHaveBeenCalledWith(15);
  });

  it('"Last day" pill maps to 31', async () => {
    const onChange = vi.fn();
    render(<Harness onChangeSpy={onChange} />);

    const userEv = userEvent.setup();
    await userEv.click(screen.getByRole('radio', { name: /Last day/ }));
    expect(onChange).toHaveBeenCalledWith(31);
  });

  it('selected pill is aria-checked=true; others are aria-checked=false', () => {
    render(<Harness initial={25} />);

    const selected   = screen.getByRole('radio', { name: /^25th$/ });
    const unselected = screen.getByRole('radio', { name: /^15th$/ });
    expect(selected).toHaveAttribute('aria-checked',   'true');
    expect(unselected).toHaveAttribute('aria-checked', 'false');
  });

  it('renders exactly the ten allowed pills when no grandfathered value', () => {
    render(<Harness />);
    const pills = screen.getAllByRole('radio');
    expect(pills).toHaveLength(10);
  });
});

describe('SalaryDayPicker — grandfathered legacy values', () => {
  it('renders an extra pill for an out-of-set currentDay, marked "current"', () => {
    render(<Harness initial={5} currentDay={5} />);

    const pills = screen.getAllByRole('radio');
    expect(pills).toHaveLength(11);    // 10 allowed + 1 grandfathered

    const grandfathered = screen.getByRole('radio', { name: /5th\s+current/i });
    expect(grandfathered).toHaveAttribute('aria-checked', 'true');
  });

  it('grandfathered pill becomes unselectable once the user picks an allowed day', async () => {
    render(<Harness initial={5} currentDay={5} />);
    const userEv = userEvent.setup();

    await userEv.click(screen.getByRole('radio', { name: /^25th$/ }));

    // Grandfathered button still rendered but disabled now.
    const grandfathered = screen.getByRole('radio', { name: /5th\s+current/i });
    expect(grandfathered).toBeDisabled();
    expect(grandfathered).toHaveAttribute('aria-disabled', 'true');
  });

  it('does NOT render a grandfathered pill when currentDay is already in the allowed set', () => {
    render(<Harness initial={25} currentDay={25} />);
    const pills = screen.getAllByRole('radio');
    expect(pills).toHaveLength(10);
  });
});

describe('SalaryDayPicker — next-collection line', () => {
  it('renders nothing when no value is selected', () => {
    render(<Harness />);
    expect(screen.queryByText(/Next collection/)).not.toBeInTheDocument();
  });

  it('shows next collection in en-ZA format with full month name', () => {
    // Today is 10 June 2026 → next salary day 25 is 25 June 2026
    render(<Harness initial={25} now={new Date('2026-06-10T12:00:00Z')} />);
    expect(screen.getByText(/25 June 2026/)).toBeInTheDocument();
  });

  it('"Last day" in February non-leap clamps to Feb 28', () => {
    render(<Harness initial={31} now={new Date('2025-02-01T12:00:00Z')} />);
    expect(screen.getByText(/28 February 2025/)).toBeInTheDocument();
  });

  it('"Last day" in February leap year clamps to Feb 29', () => {
    render(<Harness initial={31} now={new Date('2024-02-01T12:00:00Z')} />);
    expect(screen.getByText(/29 February 2024/)).toBeInTheDocument();
  });
});

describe('SalaryDayPicker — keyboard navigation', () => {
  it('ArrowRight on the selected pill moves to the next pill and fires onChange', () => {
    const onChange = vi.fn();
    render(<Harness initial={1} onChangeSpy={onChange} />);

    const first = screen.getByRole('radio', { name: /1st of the month/ });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });

    // After 1 comes 15 in the nav order.
    expect(onChange).toHaveBeenLastCalledWith(15);
  });

  it('ArrowLeft on the first pill wraps to the last', () => {
    const onChange = vi.fn();
    render(<Harness initial={1} onChangeSpy={onChange} />);

    const first = screen.getByRole('radio', { name: /1st of the month/ });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });

    // Wraps to the last allowed day (31 = "Last day").
    expect(onChange).toHaveBeenLastCalledWith(31);
  });

  it('Home jumps to the first pill, End jumps to the last', () => {
    const onChange = vi.fn();
    render(<Harness initial={25} onChangeSpy={onChange} />);

    const selected = screen.getByRole('radio', { name: /^25th$/ });
    selected.focus();

    fireEvent.keyDown(selected, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(1);

    // After Home, re-find currently-focused; for the next assert just key off
    // the document.activeElement (Home/End fire onChange which re-renders).
    fireEvent.keyDown(screen.getByRole('radio', { name: /1st of the month/ }), { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(31);
  });

  it('ArrowDown is treated the same as ArrowRight', () => {
    const onChange = vi.fn();
    render(<Harness initial={20} onChangeSpy={onChange} />);
    const selected = screen.getByRole('radio', { name: /^20th$/ });
    selected.focus();
    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(25);
  });
});

describe('SalaryDayPicker — ARIA wiring', () => {
  it('renders a radiogroup labelled by the question text', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup');
    expect(group).toBeInTheDocument();
    expect(group).toHaveAccessibleName(/when is your salary usually paid/i);
  });

  it('Month-end pills are inside a labelled sub-group', () => {
    render(<Harness />);
    // The "Month-end" label is the accessible name for its group.
    const monthEndGroup = screen.getByRole('group', { name: /month-end/i });
    expect(monthEndGroup).toBeInTheDocument();
  });

  it('only the selected pill has tabIndex=0', () => {
    render(<Harness initial={25} />);
    const selected   = screen.getByRole('radio', { name: /^25th$/ });
    const unselected = screen.getByRole('radio', { name: /^20th$/ });
    expect(selected).toHaveAttribute('tabIndex',   '0');
    expect(unselected).toHaveAttribute('tabIndex', '-1');
  });
});
