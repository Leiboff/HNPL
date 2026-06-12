'use client';

import { useState } from 'react';
import SalaryDayPicker from '@/components/SalaryDayPicker';
import { isAllowedSalaryDay } from '@/lib/salaryDates';

type Props = {
  currentDay: number | null;
  saveSalaryDay: (day: number) => Promise<{ error: string | null }>;
};

export default function SalaryDayForm({ currentDay, saveSalaryDay }: Props) {
  const [selectedDay, setSelectedDay] = useState<number | null>(currentDay);
  const [error,       setError]       = useState<string | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [saved,       setSaved]       = useState(false);

  // Submit is meaningful only when the user has chosen an allowed value
  // (legacy grandfathered values pass through the picker's initial selection
  // but can't be re-saved — the server rejects them anyway).
  const canSave = selectedDay !== null && isAllowedSalaryDay(selectedDay);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setError(null);
    setSaved(false);
    setLoading(true);
    const result = await saveSalaryDay(selectedDay);
    setLoading(false);
    if (result.error) setError(result.error);
    else setSaved(true);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <SalaryDayPicker
        value={selectedDay}
        onChange={(d) => { setSelectedDay(d); setSaved(false); }}
        currentDay={currentDay}
      />

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading || !canSave}
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
