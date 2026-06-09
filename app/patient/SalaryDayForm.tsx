'use client';

import { useState } from 'react';

type Props = {
  currentDay: number | null;
  saveSalaryDay: (day: number) => Promise<{ error: string | null }>;
};

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

export default function SalaryDayForm({ currentDay, saveSalaryDay }: Props) {
  const [selectedDay, setSelectedDay] = useState<number>(currentDay ?? 25);
  const [error,       setError]       = useState<string | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [saved,       setSaved]       = useState(false);

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
      {/* Scrollable chip row */}
      <div className="overflow-x-auto -mx-5 px-5">
        <div className="flex gap-1.5 pb-1 min-w-max">
          {DAYS.map((day) => {
            const active = selectedDay === day;
            return (
              <button
                key={day}
                type="button"
                onClick={() => { setSelectedDay(day); setSaved(false); }}
                className="w-9 h-9 rounded-xl text-sm font-semibold shrink-0 transition-all"
                style={
                  active
                    ? { background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)', color: '#fff', boxShadow: '0 4px 12px -4px rgba(21,168,158,.5)' }
                    : { background: 'rgba(19,41,75,.05)', color: '#5b6b80' }
                }
              >
                {day}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading}
          className="rounded-xl px-5 py-2 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
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
