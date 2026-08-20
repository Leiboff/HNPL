'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ALLOWED_SALARY_DAYS, isAllowedSalaryDay } from '@/lib/salaryDates';
import EmptyState from '@/components/EmptyState';
import EditIconButton from '@/components/EditIconButton';

// ─── Salary date — profile-only, edit-toggle ──────────────────────────
//
// ─── WHY THERE IS NO "LAST CHANGED" LINE HERE ─────────────────────────
//
// Stated explicitly because it is the obvious thing to want and the data does
// not exist. There is NO rule in this codebase limiting how often a salary
// date may change, and no timestamp recording when it last did:
//
//   • lib/salaryDates.ts constrains WHICH days are allowed
//     (ALLOWED_SALARY_DAYS), not how often the value may move.
//   • migration 0005 adds a CHECK for the 1..31 range. Nothing more.
//   • `profiles` has no `updated_at` and no `salary_day_changed_at`.
//
// So there is no cooldown to pre-explain and no date to show. Anyone adding a
// provenance line here needs a migration and a write in the save path first;
// until then this renders nothing, rather than "unknown" or a date derived
// from some other column that happens to be nearby.
//
// The consequence that DOES exist is already stated in the body below:
// changes apply to future plans only.
//
// Per the "profile is the source of truth" decision, the patient's
// salary day now lives ONLY on the profile. Checkout reads it
// server-side; nothing about the instalment-date computation moved
// — only where the value comes from.
//
// Display-only by default (pencil affordance); tap → dropdown enabled +
// Save / Cancel. Same edit-mode pattern as brand/practice editing.
// Changes here apply to FUTURE plans only — existing plans keep their
// original schedule (a plan's salary_day is snapshotted at creation
// and read from `plans.salary_day` for its life).

const inputCls =
  'rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

type Props = {
  current:       number | null;
  saveSalaryDay: (day: number) => Promise<{ error: string | null }>;
};

export default function SalaryDaySection({ current, saveSalaryDay }: Props) {
  const [editing, setEditing] = useState(false);
  const [day,     setDay]     = useState<number | null>(current);
  // The DISPLAYED value is a local mirror of the persisted day — not the
  // `current` prop directly. On save we advance it immediately so the row
  // shows what was just saved; the router.refresh() below re-fetches the
  // server value, and this mirror re-syncs to it when the new prop lands.
  // (The bug this fixes: reading `current` for display flashed the stale
  // old day between "Saved." and the refresh completing.)
  const [savedDay, setSavedDay] = useState<number | null>(current);
  const [error,   setError]   = useState<string | null>(null);
  const [okMsg,   setOkMsg]   = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => { setSavedDay(current); }, [current]);

  function reset() {
    setDay(savedDay);
    setError(null);
    setOkMsg(null);
    setEditing(false);
  }

  function onSave() {
    setError(null);
    setOkMsg(null);
    if (day === null || !isAllowedSalaryDay(day)) {
      setError(`Pick one of: ${ALLOWED_SALARY_DAYS.join(', ')}.`);
      return;
    }
    startTransition(async () => {
      const r = await saveSalaryDay(day);
      if (r.error) setError(r.error);
      else {
        setSavedDay(day);   // reflect the saved value immediately, no stale flash
        setOkMsg('Saved.');
        setEditing(false);
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className="text-[11px] font-semibold uppercase tracking-widest mb-1.5"
            style={{ color: '#13294B', opacity: 0.45 }}
          >
            Salary date
          </p>
          {editing ? (
            <select
              className={inputCls}
              value={day ?? ''}
              onChange={(e) => setDay(e.target.value ? Number(e.target.value) : null)}
              data-testid="profile-salary-day-select"
            >
              <option value="">Select a day…</option>
              {ALLOWED_SALARY_DAYS.map((d) => (
                <option key={d} value={d}>{ordinal(d)} of the month</option>
              ))}
            </select>
          ) : savedDay != null ? (
            <p className="text-sm font-medium text-gray-800">
              {`${ordinal(savedDay)} of the month`}
            </p>
          ) : (
            <EmptyState icon="field" title="No salary date set" inline>
              Pick the day you&rsquo;re paid and we&rsquo;ll line your instalments up with it.
            </EmptyState>
          )}
        </div>
        {!editing ? (
          <EditIconButton
            label="Edit salary date"
            onClick={() => setEditing(true)}
            testId="profile-salary-day-edit"
          />
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={isPending}
              className="text-xs text-gray-500 hover:underline disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={isPending}
              data-testid="profile-salary-day-save"
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              {isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-500">
        Sets when we collect your monthly instalments on NEW plans. Existing plans keep their current schedule.
      </p>

      {error && <p className="text-xs text-red-700">{error}</p>}
      {okMsg && <p className="text-xs text-emerald-700">{okMsg}</p>}
    </div>
  );
}
