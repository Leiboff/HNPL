'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CreateGroupInput } from './actions';

type Props = {
  createAction: (input: CreateGroupInput) => Promise<{ groupId: string | null; error: string | null }>;
};

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

export default function GroupCreateForm({ createAction }: Props) {
  const [name, setName] = useState('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return;
    startTransition(async () => {
      const r = await createAction({ name: name.trim() });
      if (r.error) {
        setError(r.error);
      } else if (r.groupId) {
        router.push(`/admin/groups/${r.groupId}`);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col sm:flex-row gap-2">
      <input
        type="text"
        placeholder="Group name — e.g. Lamberti Physiotherapy"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className={inputCls}
        disabled={isPending}
      />
      <button
        type="submit"
        disabled={isPending || !name.trim()}
        className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {isPending ? 'Creating…' : 'Create group'}
      </button>
      {error && <p className="text-xs text-red-600 sm:hidden">{error}</p>}
    </form>
  );
}
