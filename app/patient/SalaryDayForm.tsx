'use client';

import { useState } from 'react';
import { isAllowedSalaryDay } from '@/lib/salaryDates';

type Props = {
  currentDay: number | null;
  saveSalaryDay: (day: number) => Promise<{ error: string | null }>;
};

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

// Default selection when the user has no stored salary day. Picked from the
// allowed set so the calendar opens on something selectable.
const DEFAULT_PICK = 25;

export default function SalaryDayForm({ currentDay, saveSalaryDay }: Props) {
  const initial = currentDay ?? DEFAULT_PICK;
  const [selectedDay, setSelectedDay] = useState<number>(initial);
  const [error,       setError]       = useState<string | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [saved,       setSaved]       = useState(false);

  // Whether `currentDay` itself is a legacy value outside the allowed set —
  // we keep it visually selected on first paint, but the user can only pick
  // a new day from the allowed set.
  const grandfathered = currentDay !== null && !isAllowedSalaryDay(currentDay);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setLoading(true);
    const result = await saveSalaryDay(selectedDay);
    setLoading(false);
    if (result.error) setError(result.error);
    else setSaved(true);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-xs text-gray-500">
        Choose the day your salary is usually paid.
      </p>

      {/* Calendar grid — 7 columns, days 1–31. Non-allowed days are visible
          but disabled. A grandfathered (legacy) salary_day stays highlighted
          on first paint but is not re-selectable. */}
      <div className="grid grid-cols-7 gap-0.5 w-fit">
        {DAYS.map((day) => {
          const isAllowed = isAllowedSalaryDay(day);
          const active    = selectedDay === day;
          // Keep grandfathered current day visually selected but not clickable.
          const grandfatheredActive = grandfathered && active && !isAllowed;
          const disabled  = !isAllowed;

          const baseClass = 'w-8 h-8 flex items-center justify-center rounded-full text-xs font-medium transition-all';
          const stateClass = active
            ? ''
            : isAllowed
              ? 'hover:bg-gray-100'
              : 'cursor-not-allowed';

          return (
            <button
              key={day}
              type="button"
              disabled={disabled}
              aria-disabled={disabled}
              title={
                grandfatheredActive
                  ? 'Your existing salary date — pick a new one from the highlighted options to change it.'
                  : disabled
                    ? 'Not selectable'
                    : undefined
              }
              onClick={() => { if (isAllowed) { setSelectedDay(day); setSaved(false); } }}
              className={`${baseClass} ${stateClass}`}
              style={
                active
                  ? {
                      background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)',
                      color: '#fff',
                      boxShadow: '0 2px 8px -2px rgba(21,168,158,.55)',
                    }
                  : isAllowed
                    ? { color: '#5b6b80' }
                    : { color: '#cbd5e0' /* grey-300 */ }
              }
            >
              {day}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading || !isAllowedSalaryDay(selectedDay)}
          className="rounded-lg px-5 py-2.5 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {loading ? 'Saving…' : 'Save'}
        </button>
        {saved && !loading && (
          <span className="text-sm font-medium" style={{ color: '#15A89E' }}>Saved ✓</span>
        )}
        {error && (
          <span className="text-sm text-red-600">{error}</span>
        )}
      </div>

    </form>
  );
}
