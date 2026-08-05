'use client';

import { useId, useMemo, useRef } from 'react';
import { ALLOWED_SALARY_DAYS, isAllowedSalaryDay } from '@/lib/salaryDates';

/**
 * Display label for a salary day. `1` and `31` get human-readable copy;
 * everything else gets a standard ordinal suffix.
 */
export function pillLabel(day: number): string {
  if (day === 31) return 'Last day';
  const lastTwo = day % 100;
  const last    = day % 10;
  if (lastTwo >= 11 && lastTwo <= 13) return `${day}th`;
  if (last === 1) return `${day}st`;
  if (last === 2) return `${day}nd`;
  if (last === 3) return `${day}rd`;
  return `${day}th`;
}

type Props = {
  value: number | null;
  onChange: (day: number) => void;
  /**
   * The user's existing stored salary day, if any. When this is outside
   * the allowed set we render a "current" pill so they can recognise their
   * legacy choice — selectable only as long as no other pill has been
   * chosen this session.
   */
  currentDay?: number | null;
  /** Optional id prefix for ARIA labelling. Auto-generated if omitted. */
  idPrefix?: string;
};

export default function SalaryDayPicker({
  value,
  onChange,
  currentDay = null,
  idPrefix,
}: Props) {
  const autoId       = useId();
  const idBase       = idPrefix ?? autoId;
  const groupLabelId = `${idBase}-group-label`;

  const grandfathered = currentDay !== null && !isAllowedSalaryDay(currentDay);
  // The legacy pill is only navigable while still the active selection —
  // once they pick a standard pill, the grandfathered pill is visible but
  // not reachable via click or arrow keys.
  const grandfatheredActive = grandfathered && value === currentDay;

  /**
   * Ordered list used for keyboard navigation. The grandfathered pill is
   * only included while still selected; after the user picks an allowed
   * day it falls out of the navigation order.
   */
  const navOrder = useMemo<number[]>(() => {
    // Widen the readonly tuple to number[] so we can append a grandfathered
    // day that isn't a literal member of the allowed-day union.
    const days: number[] = [...ALLOWED_SALARY_DAYS];
    if (grandfatheredActive && currentDay !== null) days.push(currentDay);
    return days;
  }, [grandfatheredActive, currentDay]);

  const groupRef = useRef<HTMLDivElement>(null);

  function focusDay(day: number) {
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      return;
    }
    e.preventDefault();

    const fallback = navOrder[0];
    const currentIdx = value !== null && navOrder.includes(value)
      ? navOrder.indexOf(value)
      : 0;

    let nextIdx = currentIdx;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown': nextIdx = (currentIdx + 1) % navOrder.length; break;
      case 'ArrowLeft':
      case 'ArrowUp':   nextIdx = (currentIdx - 1 + navOrder.length) % navOrder.length; break;
      case 'Home':      nextIdx = 0; break;
      case 'End':       nextIdx = navOrder.length - 1; break;
    }
    const nextDay = navOrder[nextIdx] ?? fallback;
    onChange(nextDay);
    // Defer focus until React commits the new tabIndex set so the receiving
    // pill is reachable in the tab order.
    requestAnimationFrame(() => focusDay(nextDay));
  }

  return (
    <div>
      <p
        id={groupLabelId}
        className="text-[14px] font-semibold"
        style={{ color: '#13294B' }}
      >
        When is your salary usually paid?
      </p>

      <div
        ref={groupRef}
        role="radiogroup"
        aria-labelledby={groupLabelId}
        onKeyDown={handleKeyDown}
        className="mt-3.5 grid grid-cols-4 gap-[9px]"
      >
        {ALLOWED_SALARY_DAYS.map((d) => (
          <Pill
            key={d}
            day={d}
            selected={value === d}
            onSelect={() => onChange(d)}
            tabIndex={value === d ? 0 : -1}
            // With nine numeric days + "Last day" in a 4-col grid, the
            // 30th lands alone at the start of the last row; "Last day"
            // spans the remaining three columns to fill it cleanly.
            wide={d === 31}
          />
        ))}
      </div>

      {/* Grandfathered pill — out-of-set legacy value. Sits below the grid
          so it doesn't break uniformity, and carries a "current" badge. */}
      {grandfathered && currentDay !== null && (
        <div className="mt-[9px] grid grid-cols-4 gap-[9px]">
          <Pill
            day={currentDay}
            selected={value === currentDay}
            onSelect={grandfatheredActive ? () => onChange(currentDay) : undefined}
            tabIndex={value === currentDay ? 0 : -1}
            currentBadge
          />
        </div>
      )}
    </div>
  );
}

// ── Pill ──────────────────────────────────────────────────────────────────

type PillProps = {
  day:          number;
  selected:     boolean;
  /** Falsy = not selectable (grandfathered pill once user has moved off). */
  onSelect?:    () => void;
  tabIndex:     0 | -1;
  /** Renders the small "current" badge on the grandfathered legacy pill. */
  currentBadge?: boolean;
  /** Span three grid columns ("Last day" in the 4-col layout). */
  wide?: boolean;
};

function Pill({ day, selected, onSelect, tabIndex, currentBadge, wide }: PillProps) {
  const disabled = !onSelect;

  // Colour-only state change — the primary CTA stays the only solid-teal
  // element on the screen; chips just tint.
  //   Selected:   2px teal border, teal tint, teal-dark 600 text, leading ✓
  //   Unselected: 1.5px hairline border, faint fill, body-slate text
  //   Disabled:   dimmed (grandfathered pill once user moves off it)
  const stateClass = selected
    ? 'border-2 border-[#15A89E] font-semibold'
    : disabled
      ? 'border-[1.5px] border-[#E2E8EE] bg-[#F1F5F6] text-[#8496AA] cursor-not-allowed'
      : 'border-[1.5px] border-[#E2E8EE] bg-[#FBFCFD] text-[#41556F] hover:border-[#CBD6E0]';

  const layoutClass = wide ? 'col-span-3' : '';

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      tabIndex={tabIndex}
      data-day={day}
      disabled={disabled}
      onClick={onSelect}
      className={`${layoutClass} flex h-[46px] w-full items-center justify-center gap-2 rounded-[14px] text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#15A89E] focus-visible:ring-offset-2 ${stateClass}`}
      style={selected ? { background: 'rgba(21,168,158,0.10)', color: '#0F766E' } : undefined}
    >
      {selected && (
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="h-[15px] w-[15px] shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 10.5l3 3 7-7" />
        </svg>
      )}
      <span>{pillLabel(day)}</span>
      {currentBadge && (
        <span className={`text-[10px] font-semibold uppercase tracking-wider rounded px-1.5 py-0.5 ${selected ? 'bg-[#15A89E]/15 text-[#0F766E]' : 'bg-gray-200 text-gray-700'}`}>
          current
        </span>
      )}
    </button>
  );
}

// Re-export ALLOWED_SALARY_DAYS for callers that need both the picker and
// the canonical set in one import.
export { ALLOWED_SALARY_DAYS };
