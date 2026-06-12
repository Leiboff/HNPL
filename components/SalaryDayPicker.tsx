'use client';

import { useId, useMemo, useRef } from 'react';
import {
  ALLOWED_SALARY_DAYS,
  isAllowedSalaryDay,
  nextCollectionDate,
} from '@/lib/salaryDates';

// Visual rows. Order matters — also drives keyboard traversal.
const TOP_ROW       = [1, 15, 20] as const;
const MONTH_END_ROW = [25, 26, 27, 28, 29, 30, 31] as const;

/**
 * Display label for a salary day. `1` and `31` get human-readable copy;
 * everything else gets a standard ordinal suffix.
 */
export function pillLabel(day: number): string {
  if (day === 1)  return '1st of the month';
  if (day === 31) return 'Last day';
  const lastTwo = day % 100;
  const last    = day % 10;
  if (lastTwo >= 11 && lastTwo <= 13) return `${day}th`;
  if (last === 1) return `${day}st`;
  if (last === 2) return `${day}nd`;
  if (last === 3) return `${day}rd`;
  return `${day}th`;
}

/**
 * SA-locale date format: "30 June 2026". Use UTC so the formatter doesn't
 * shift the day across the local timezone boundary — the input Date is
 * always UTC-midnight from `nextCollectionDate`.
 */
function formatCollectionDate(d: Date): string {
  return new Intl.DateTimeFormat('en-ZA', {
    day:      'numeric',
    month:    'long',
    year:     'numeric',
    timeZone: 'UTC',
  }).format(d);
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
  /** Override "now" for tests so next-collection output is deterministic. */
  now?: Date;
};

export default function SalaryDayPicker({
  value,
  onChange,
  currentDay = null,
  idPrefix,
  now,
}: Props) {
  const autoId         = useId();
  const idBase         = idPrefix ?? autoId;
  const groupLabelId   = `${idBase}-group-label`;
  const monthEndLabelId = `${idBase}-monthend-label`;

  const grandfathered = currentDay !== null && !isAllowedSalaryDay(currentDay);
  // The legacy pill is only navigable while still the active selection —
  // once they pick a standard pill, the grandfathered pill is visible but
  // not reachable via click or arrow keys.
  const grandfatheredActive = grandfathered && value === currentDay;

  /**
   * Ordered list used for keyboard navigation. Stays stable across re-renders
   * so arrow keys advance predictably; the grandfathered pill is only included
   * while still selected (after the user picks an allowed day, it falls out).
   */
  const navOrder = useMemo<number[]>(() => {
    const days: number[] = [...TOP_ROW, ...MONTH_END_ROW];
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

  const nextDate = value !== null && Number.isInteger(value)
    ? nextCollectionDate(value, now ?? new Date())
    : null;

  return (
    <div>
      <p
        id={groupLabelId}
        className="text-sm font-medium text-gray-900"
      >
        When is your salary usually paid?
      </p>

      <div
        ref={groupRef}
        role="radiogroup"
        aria-labelledby={groupLabelId}
        onKeyDown={handleKeyDown}
        className="mt-3 space-y-4"
      >
        {/* Top row: standalone days */}
        <div className="flex flex-wrap gap-2">
          {TOP_ROW.map((d) => (
            <Pill
              key={d}
              day={d}
              selected={value === d}
              onSelect={() => onChange(d)}
              tabIndex={value === d ? 0 : -1}
            />
          ))}
        </div>

        {/* Month-end group */}
        <div>
          <p
            id={monthEndLabelId}
            className="text-xs font-semibold uppercase tracking-wider text-gray-600 mb-2"
          >
            Month-end
          </p>
          <div
            role="group"
            aria-labelledby={monthEndLabelId}
            className="flex flex-wrap gap-2"
          >
            {MONTH_END_ROW.map((d) => (
              <Pill
                key={d}
                day={d}
                selected={value === d}
                onSelect={() => onChange(d)}
                tabIndex={value === d ? 0 : -1}
              />
            ))}
          </div>
        </div>

        {/* Grandfathered pill — out-of-set legacy value */}
        {grandfathered && currentDay !== null && (
          <div className="pt-1">
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

      {nextDate && (
        <p className="mt-5 text-sm text-gray-700" aria-live="polite">
          <span className="font-medium text-gray-900">Next collection:</span>{' '}
          {formatCollectionDate(nextDate)}
        </p>
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
};

function Pill({ day, selected, onSelect, tabIndex, currentBadge }: PillProps) {
  const disabled = !onSelect;

  // Selected: brand gradient + white text. Unselected: white bg + gray-700
  // text (WCAG AA ≥ 4.5:1 on white). Disabled (grandfathered after move-off):
  // gray-500 (still ≥ 4.5:1, just dimmed).
  const stateClass = selected
    ? 'text-white border border-transparent shadow-sm'
    : disabled
      ? 'text-gray-500 bg-gray-50 border border-gray-200 cursor-not-allowed'
      : 'text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 hover:border-gray-400';

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
      className={`inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2.5 rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#15A89E] focus-visible:ring-offset-2 ${stateClass}`}
      style={selected ? { background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' } : undefined}
    >
      {pillLabel(day)}
      {currentBadge && (
        <span className={`text-[10px] font-semibold uppercase tracking-wider rounded px-1.5 py-0.5 ${selected ? 'bg-white/20 text-white' : 'bg-gray-200 text-gray-700'}`}>
          current
        </span>
      )}
    </button>
  );
}

// Re-export ALLOWED_SALARY_DAYS for callers that need both the picker and
// the canonical set in one import.
export { ALLOWED_SALARY_DAYS };
