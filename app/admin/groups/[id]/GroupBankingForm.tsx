'use client';

import { useState, useTransition } from 'react';
import type { UpdateGroupBankingInput } from '../actions';

type Initial = {
  bankName:          string | null;
  bankAccountNumber: string | null;
  branchCode:        string | null;
  accountHolder:     string | null;
  accountType:       'current' | 'savings' | null;
};

type Props = {
  groupId:    string;
  initial:    Initial;
  saveAction: (input: UpdateGroupBankingInput) => Promise<{ error: string | null }>;
};

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

export default function GroupBankingForm({ groupId, initial, saveAction }: Props) {
  const [bankName,          setBankName]          = useState(initial.bankName          ?? '');
  const [bankAccountNumber, setBankAccountNumber] = useState(initial.bankAccountNumber ?? '');
  const [branchCode,        setBranchCode]        = useState(initial.branchCode        ?? '');
  const [accountHolder,     setAccountHolder]     = useState(initial.accountHolder     ?? '');
  const [accountType,       setAccountType]       = useState<'current' | 'savings' | ''>(initial.accountType ?? '');
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const r = await saveAction({
        groupId,
        bankName:          bankName.trim()          || null,
        bankAccountNumber: bankAccountNumber.trim() || null,
        branchCode:        branchCode.trim()        || null,
        accountHolder:     accountHolder.trim()     || null,
        accountType:       accountType || null,
      });
      if (r.error) setMessage({ kind: 'error', text: r.error });
      else         setMessage({ kind: 'ok',    text: 'Group banking saved.' });
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input className={inputCls} placeholder="Bank name"        value={bankName}          onChange={(e) => setBankName(e.target.value)} />
        <input className={inputCls} placeholder="Account number"   value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} />
        <input className={inputCls} placeholder="Branch code"      value={branchCode}        onChange={(e) => setBranchCode(e.target.value)} />
        <input className={inputCls} placeholder="Account holder"   value={accountHolder}     onChange={(e) => setAccountHolder(e.target.value)} />
        <select
          className={inputCls}
          value={accountType}
          onChange={(e) => setAccountType((e.target.value as 'current' | 'savings' | '') || '')}
        >
          <option value="">Account type (optional)</option>
          <option value="current">Current</option>
          <option value="savings">Savings</option>
        </select>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {isPending ? 'Saving…' : 'Save banking'}
        </button>
        {message && (
          <p className={`text-xs ${message.kind === 'ok' ? 'text-green-700' : 'text-red-700'}`}>
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}
