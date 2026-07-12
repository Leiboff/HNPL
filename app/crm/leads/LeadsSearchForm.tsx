'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LeadsSearchForm({ initialQ }: { initialQ: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(initialQ);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const u = new URLSearchParams(Array.from(params.entries()));
    if (q) u.set('q', q); else u.delete('q');
    router.push(`/crm/leads?${u.toString()}`);
  }

  return (
    <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2 items-stretch">
      <label htmlFor="q" className="sr-only">Search leads</label>
      <input
        id="q"
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search practice, contact, email, phone…"
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 pl-9 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E]"
      />
      <button
        type="submit"
        className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium"
      >
        Search
      </button>
    </form>
  );
}
