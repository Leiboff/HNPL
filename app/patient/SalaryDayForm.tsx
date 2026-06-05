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
        className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-[#0F4C75] focus:outline-none focus:ring-1 focus:ring-[#0F4C75]"
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
        className="rounded-lg bg-[#0F4C75] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0a3a5c] focus:outline-none focus:ring-2 focus:ring-[#0F4C75] focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? 'Saving…' : 'Save'}
      </button>

      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}
    </form>
  );
}
