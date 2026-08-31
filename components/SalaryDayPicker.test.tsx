import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import SalaryDayPicker, { pillLabel, type PickerTone } from './SalaryDayPicker';

// Pure-function test for the label mapping (incl. "Last day" → 31).

describe('pillLabel', () => {
  it.each([
    [1,  '1st'],
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
  onChangeSpy,
  tone,
}: {
  initial?: number | null;
  currentDay?: number | null;
  onChangeSpy?: (d: number) => void;
  tone?: PickerTone;
}) {
  const [value, setValue] = useState<number | null>(initial);
  return (
    <SalaryDayPicker
      value={value}
      onChange={(d) => { setValue(d); onChangeSpy?.(d); }}
      currentDay={currentDay}
      tone={tone}
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

describe('SalaryDayPicker — keyboard navigation', () => {
  it('ArrowRight on the selected pill moves to the next pill and fires onChange', () => {
    const onChange = vi.fn();
    render(<Harness initial={1} onChangeSpy={onChange} />);

    const first = screen.getByRole('radio', { name: /^1st$/ });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });

    // After 1 comes 15 in the nav order.
    expect(onChange).toHaveBeenLastCalledWith(15);
  });

  it('ArrowLeft on the first pill wraps to the last', () => {
    const onChange = vi.fn();
    render(<Harness initial={1} onChangeSpy={onChange} />);

    const first = screen.getByRole('radio', { name: /^1st$/ });
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

    fireEvent.keyDown(screen.getByRole('radio', { name: /^1st$/ }), { key: 'End' });
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

describe('SalaryDayPicker — selected-state styling (light tone)', () => {
  it('selected pill carries the teal 2px border + a TINTED fill (not a solid CTA fill)', () => {
    render(<Harness initial={25} />);
    const selected = screen.getByRole('radio', { name: /^25th$/ });
    expect(selected.className).toMatch(/\bborder-2\b/);
    expect(selected.className).toMatch(/border-\[#15A89E\]/);
    // Tinted teal fill + teal-dark label. The tint moved from an inline
    // style to a class when the picker gained its dark tone (both tones
    // are now table-driven, see TONES in SalaryDayPicker.tsx) — what
    // matters is that it is a TINT: the primary CTA stays the only
    // solid-teal element on the screen.
    expect(selected.className).toMatch(/bg-\[#15A89E\]\/10/);
    expect(selected.className).toMatch(/text-\[#0F766E\]/);
    expect(selected.className).not.toMatch(/bg-\[#15A89E\](?!\/)/);
  });

  it('unselected pill uses the hairline border + faint fill + body-slate text', () => {
    render(<Harness initial={25} />);
    const unselected = screen.getByRole('radio', { name: /^15th$/ });
    expect(unselected.className).toMatch(/border-\[1\.5px\]/);
    expect(unselected.className).toMatch(/border-\[#E2E8EE\]/);
    expect(unselected.className).toMatch(/bg-\[#FBFCFD\]/);
    expect(unselected.className).toMatch(/text-\[#41556F\]/);
  });

  it('no pill in either tone carries an inline style (the palette is class-driven)', () => {
    render(<Harness initial={25} />);
    for (const name of [/^25th$/, /^15th$/]) {
      expect(screen.getByRole('radio', { name }).getAttribute('style')).toBeFalsy();
    }
  });

  it('"Last day" pill spans three columns in the 4-col grid', () => {
    render(<Harness />);
    const lastDay = screen.getByRole('radio', { name: /Last day/ });
    expect(lastDay.className).toMatch(/col-span-3/);
  });
});

describe('SalaryDayPicker — ARIA wiring', () => {
  it('renders a radiogroup labelled by the question text', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup');
    expect(group).toBeInTheDocument();
    expect(group).toHaveAccessibleName(/when is your salary usually paid/i);
  });

  it('does not render a Month-end sub-group (flat single set of options)', () => {
    render(<Harness />);
    expect(screen.queryByRole('group', { name: /month-end/i })).not.toBeInTheDocument();
  });

  it('only the selected pill has tabIndex=0', () => {
    render(<Harness initial={25} />);
    const selected   = screen.getByRole('radio', { name: /^25th$/ });
    const unselected = screen.getByRole('radio', { name: /^20th$/ });
    expect(selected).toHaveAttribute('tabIndex',   '0');
    expect(unselected).toHaveAttribute('tabIndex', '-1');
  });
});

// ─── Dark tone ──────────────────────────────────────────────────────────────
//
// The /onboarding salary step renders the picker on the navy auth
// surface. Same component, same radiogroup — only the palette differs,
// and every dark value must come from the .auth-surface tokens rather
// than a hex the picker invented for itself.

describe('SalaryDayPicker — tone="onDark"', () => {
  it('selected pill uses the auth accent, tinted (still not a solid fill)', () => {
    render(<Harness initial={25} tone="onDark" />);
    const selected = screen.getByRole('radio', { name: /^25th$/ });
    expect(selected.className).toMatch(/border-2/);
    expect(selected.className).toMatch(/border-\[var\(--auth-accent\)\]/);
    expect(selected.className).toMatch(/bg-\[var\(--auth-accent-tint\)\]/);
    expect(selected.className).toMatch(/text-white/);
  });

  it('unselected pill uses the auth edge + raised fill + muted text', () => {
    render(<Harness initial={25} tone="onDark" />);
    const unselected = screen.getByRole('radio', { name: /^15th$/ });
    expect(unselected.className).toMatch(/border-\[var\(--auth-edge\)\]/);
    expect(unselected.className).toMatch(/bg-\[var\(--auth-fill-raised\)\]/);
    expect(unselected.className).toMatch(/text-\[var\(--auth-muted\)\]/);
  });

  it('no light-ground hex leaks into the dark tone', () => {
    render(<Harness initial={25} tone="onDark" />);
    for (const name of [/^25th$/, /^15th$/, /Last day/]) {
      const cls = screen.getByRole('radio', { name }).className;
      expect(cls).not.toMatch(/#E2E8EE|#FBFCFD|#41556F|#0F766E|#F1F5F6/);
    }
  });

  it('pins the focus ring offset to the navy, so focus draws no white halo', () => {
    render(<Harness initial={25} tone="onDark" />);
    const selected = screen.getByRole('radio', { name: /^25th$/ });
    expect(selected.className).toMatch(/focus-visible:ring-offset-\[#0E2140\]/);
  });

  it('behaviour is identical in both tones — clicking still reports the day', async () => {
    const onChange = vi.fn();
    render(<Harness tone="onDark" onChangeSpy={onChange} />);
    await userEvent.setup().click(screen.getByRole('radio', { name: /^20th$/ }));
    expect(onChange).toHaveBeenCalledWith(20);
  });

  it('defaults to the light tone when no tone is passed', () => {
    render(<Harness initial={25} />);
    expect(screen.getByRole('radio', { name: /^25th$/ }).className).toMatch(/border-\[#15A89E\]/);
  });
});
