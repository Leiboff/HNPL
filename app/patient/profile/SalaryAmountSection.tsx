'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { isValidSalaryAmount } from '@/lib/salaryAmount';
import { formatRand } from '@/app/patient/_format';
import EmptyState from '@/components/EmptyState';
import EditIconButton from '@/components/EditIconButton';
import ProfileFieldRow from '@/components/ProfileFieldRow';

// ─── Salary amount — profile-only, edit-toggle ────────────────────────
//
// Sibling to SalaryDaySection, same pattern: display-only by default
// (pencil affordance), tap → number input enabled + Save / Cancel. Lives
// alongside salary date and the locked identity fields inside Personal
// details (see app/patient/account/personal/page.tsx) rather than as its
// own accordion section — unlike salary date, this one was never split
// out, so there's no prior deep-link or "own section" history to unwind.
//
// No provenance line, same reasoning as SalaryDaySection: profiles has no
// updated_at and no salary_amount_changed_at, and there is no cooldown
// rule on how often it may change. Nothing here is read by pricing or
// scheduling yet — it is capture only, same as salary_day was before
// lib/finance.ts's scheduler consumed it (see migration 0100).

const inputCls =
  'h-[42px] w-full rounded-lg border border-gray-300 pl-7 pr-3 text-sm text-gray-900 ' +
  'focus:border-[var(--portal-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--portal-accent)]';

type Props = {
  current:          number | null;
  saveSalaryAmount: (amount: number) => Promise<{ error: string | null }>;
};

export default function SalaryAmountSection({ current, saveSalaryAmount }: Props) {
  const [editing, setEditing] = useState(false);
  const [value,   setValue]   = useState(current != null ? String(current) : '');
  // Same "displayed value mirrors the persisted value, not the prop
  // directly" trick as SalaryDaySection — avoids a stale-value flash
  // between "Saved." and router.refresh() landing.
  const [savedAmount, setSavedAmount] = useState<number | null>(current);
  const [error,   setError]   = useState<string | null>(null);
  const [okMsg,   setOkMsg]   = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => { setSavedAmount(current); }, [current]);

  function reset() {
    setValue(savedAmount != null ? String(savedAmount) : '');
    setError(null);
    setOkMsg(null);
    setEditing(false);
  }

  function onSave() {
    setError(null);
    setOkMsg(null);
    const amount = Number(value);
    if (!isValidSalaryAmount(amount)) {
      setError('Enter how much you earn a month.');
      return;
    }
    startTransition(async () => {
      const r = await saveSalaryAmount(amount);
      if (r.error) setError(r.error);
      else {
        setSavedAmount(amount);
        setOkMsg('Saved.');
        setEditing(false);
        router.refresh();
      }
    });
  }

  return (
    <ProfileFieldRow
      icon="income"
      label="Monthly income"
      action={
        !editing ? (
          <EditIconButton
            label="Edit monthly income"
            onClick={() => setEditing(true)}
            testId="profile-salary-amount-edit"
          />
        ) : (
          <div className="flex items-center gap-2 shrink-0">
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
              data-testid="profile-salary-amount-save"
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, var(--portal-ink) 0%, var(--portal-accent) 145%)' }}
            >
              {isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        )
      }
    >
      {editing ? (
        <div className="relative max-w-[220px]">
          <span
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500"
          >
            R
          </span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            data-testid="profile-salary-amount-input"
            placeholder="15,000"
            className={inputCls}
          />
        </div>
      ) : savedAmount != null ? (
        <p className="text-sm font-medium text-gray-800">{formatRand(savedAmount)} / month</p>
      ) : (
        <EmptyState icon="field" title="No income on file" inline>
          Add what you earn a month — used for the affordability check.
        </EmptyState>
      )}

      {error && <p className="mt-1.5 text-xs text-red-700">{error}</p>}
      {okMsg && <p className="mt-1.5 text-xs text-emerald-700">{okMsg}</p>}
    </ProfileFieldRow>
  );
}
