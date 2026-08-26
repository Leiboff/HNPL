'use client';

import { useState } from 'react';
import TodayTaskRow, { type TodayTask } from './TodayTaskRow';

// ─── Calls to log — the two-tap flow lives here ────────────────────────

export default function TodayCallsToLog({ tasks: initial }: { tasks: TodayTask[] }) {
  const [tasks, setTasks] = useState(initial);
  if (tasks.length === 0) return null;

  return (
    <section className="bg-white rounded-2xl border border-gray-200 overflow-hidden" data-testid="today-calls-to-log">
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-900">Calls to log</h2>
        <span className="inline-flex items-center rounded-full bg-gray-100 text-gray-700 px-2 py-0.5 text-xs font-medium">
          {tasks.length}
        </span>
      </header>
      <ul className="divide-y divide-gray-100">
        {tasks.map(t => (
          <TodayTaskRow key={t.id} task={t} onDone={(id) => setTasks(prev => prev.filter(x => x.id !== id))} />
        ))}
      </ul>
    </section>
  );
}
