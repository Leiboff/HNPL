'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { UpdateBranchBankingInput } from '@/app/brand/actions';

type Initial = {
  bankName:          string | null;
  bankAccountNumber: string | null;
  branchCode:        string | null;
  accountHolder:     string | null;
  accountType:       'current' | 'savings' | null;
};

type Props = {
  practiceId:  string;
  initial:     Initial;
  saveAction:  (input: UpdateBranchBankingInput) => Promise<{ error: string | null }>;
};

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

export default function BranchBankingForm({ practiceId, initial, saveAction }: Props) {
  const [editing, setEditing] = useState(false);
  const [bankName,          setBankName]          = useState(initial.bankName          ?? '');
  const [bankAccountNumber, setBankAccountNumber] = useState(initial.bankAccountNumber ?? '');
  const [branchCode,        setBranchCode]        = useState(initial.branchCode        ?? '');
  const [accountHolder,     setAccountHolder]     = useState(initial.accountHolder     ?? '');
  const [accountType,       setAccountType]       = useState<'current' | 'savings' | ''>(initial.accountType ?? '');

  const [error,   setError]   = useState<string | null>(null);
  const [okMsg,   setOkMsg]   = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function reset() {
    setBankName(initial.bankName ?? '');
    setBankAccountNumber(initial.bankAccountNumber ?? '');
    setBranchCode(initial.branchCode ?? '');
    setAccountHolder(initial.accountHolder ?? '');
    setAccountType(initial.accountType ?? '');
    setError(null);
    setOkMsg(null);
    setEditing(false);
  }

  function onSave() {
    setError(null);
    setOkMsg(null);
    startTransition(async () => {
      const r = await saveAction({
        practiceId,
        bankName:          bankName          || null,
        bankAccountNumber: bankAccountNumber || null,
        branchCode:        branchCode        || null,
        accountHolder:     accountHolder     || null,
        accountType:       accountType       || null,
      });
      if (r.error) setError(r.error);
      else {
        setOkMsg('Saved.');
        setEditing(false);
        router.refresh();
      }
    });
  }

  return (
    <section className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold" style={{ color: '#13294B' }}>Banking</h2>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            data-testid="branch-banking-edit"
            className="text-xs font-semibold underline underline-offset-2"
            style={{ color: '#13294B' }}
          >
            Edit
          </button>
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
              data-testid="branch-banking-save"
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              {isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-500">
        BetterNow pays activated plans into this account, minus the commission. Empty fields fall back to the brand&apos;s banking.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Bank">
          {editing
            ? <input className={inputCls} value={bankName} onChange={(e) => setBankName(e.target.value)} />
            : <p className="text-sm text-gray-900">{bankName || '—'}</p>}
        </Field>
        <Field label="Branch code">
          {editing
            ? <input className={inputCls} value={branchCode} onChange={(e) => setBranchCode(e.target.value)} />
            : <p className="text-sm text-gray-900">{branchCode || '—'}</p>}
        </Field>
        <Field label="Account holder">
          {editing
            ? <input className={inputCls} value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)} />
            : <p className="text-sm text-gray-900">{accountHolder || '—'}</p>}
        </Field>
        <Field label="Account number">
          {editing
            ? <input className={inputCls} value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} />
            : <p className="text-sm text-gray-900">{bankAccountNumber || '—'}</p>}
        </Field>
        <Field label="Account type">
          {editing ? (
            <select
              className={inputCls}
              value={accountType}
              onChange={(e) => setAccountType(e.target.value as 'current' | 'savings' | '')}
            >
              <option value="">—</option>
              <option value="current">Current</option>
              <option value="savings">Savings</option>
            </select>
          ) : (
            <p className="text-sm text-gray-900">{accountType || '—'}</p>
          )}
        </Field>
      </div>

      {error && <p className="text-xs text-red-700">{error}</p>}
      {okMsg && <p className="text-xs text-emerald-700">{okMsg}</p>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}
