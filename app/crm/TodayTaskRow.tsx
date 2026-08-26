'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { completeTask } from './leads/tasksActions';
import { TASK_OUTCOMES, TASK_OUTCOME_LABELS } from '@/lib/crm/taskOutcomes';

export type TodayTask = {
  id: string;
  lead_id: string | null;
  practice_name: string | null;
  type: string;
  title: string;
  due_at: string;
  overdue: boolean;
};

// ─── One row on Today, with a two-tap "log call" flow ─────────────────
//
// Tap 1: open the outcome picker. Tap 2: pick an outcome — that single
// click IS the submit, no separate confirm step. Measured, not
// assumed: two DOM interactions from page-load to a completed,
// outcome-tagged task.

export default function TodayTaskRow({ task, onDone }: { task: TodayTask; onDone: (taskId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function pickOutcome(outcome: (typeof TASK_OUTCOMES)[number]) {
    startTransition(async () => {
      const res = await completeTask(task.id, outcome);
      if (res.error) { setError(res.error); return; }
      onDone(task.id);
    });
  }

  return (
    <li className="px-4 py-3" data-testid={`today-task:${task.id}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          {task.lead_id ? (
            <Link href={`/crm/leads/${task.lead_id}`} className="text-sm font-medium text-gray-900 hover:underline truncate block">
              {task.practice_name ?? 'Lead'}
            </Link>
          ) : (
            <p className="text-sm font-medium text-gray-900 truncate">{task.title}</p>
          )}
          <p className="text-xs text-gray-500 capitalize">
            {task.type} · {task.overdue ? 'overdue' : 'due today'}
          </p>
        </div>
        {task.type === 'call' && !open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={pending}
            className="rounded-lg bg-[#13294B] text-white px-3 py-1.5 text-xs font-medium disabled:opacity-60 shrink-0"
            data-testid={`today-log-call:${task.id}`}
          >
            Log call
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 flex gap-1.5 flex-wrap" data-testid={`today-outcome-picker:${task.id}`}>
          {TASK_OUTCOMES.map(o => (
            <button
              key={o}
              type="button"
              onClick={() => pickOutcome(o)}
              disabled={pending}
              className="rounded-full border border-gray-200 bg-white text-gray-700 px-3 py-1 text-xs font-medium hover:border-[#15A89E] hover:text-[#15A89E] disabled:opacity-60"
              data-testid={`today-outcome:${task.id}:${o}`}
            >
              {TASK_OUTCOME_LABELS[o]}
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
    </li>
  );
}
