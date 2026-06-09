'use client';

import { useState } from 'react';

type Props = {
  currentDay: number | null;
  saveSalaryDay: (day: number) => Promise<{ error: string | null }>;
};

export default function SalaryDayForm({ currentDay, saveSalaryDay }: Props) {
  const [selectedDay, setSelectedDay] = useState<number>(currentDay ?? 1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const result = await saveSalaryDay(selectedDay);

    if (result.error) {
      setError(result.error);
    }

    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex items-center gap-3">
      <select
        value={selectedDay}
        onChange={(e) => setSelectedDay(Number(e.target.value))}
        className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]"
      >
        {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
          <option key={day} value={day}>
            {day}
          </option>
        ))}
      </select>

      <button
        type="submit"
        disabled={loading}
        className="rounded-lg px-4 py-2 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {loading ? 'Saving…' : 'Save'}
      </button>

      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}
    </form>
  );
}
