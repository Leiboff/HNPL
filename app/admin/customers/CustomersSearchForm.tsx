'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

// Client-side search form for /admin/customers. Submits via the
// router so the query is reflected in the URL (shareable / bookmarkable),
// preserving any sort param the user picked.
//
// Form submission is debounced trivially: the form is uncontrolled
// except for the input value; we navigate on submit only, not on
// every keystroke, to keep server load reasonable.

export default function CustomersSearchForm({ initialQ }: { initialQ: string }) {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const [q, setQ]    = useState(initialQ);
  const [isPending, startTransition] = useTransition();

  function submit(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set('q', value);
    else       params.delete('q');
    startTransition(() => {
      router.push(`/admin/customers?${params.toString()}`);
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(q.trim());
      }}
      className="flex gap-2 items-center"
    >
      <div className="relative flex-1">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, email, or phone…"
          aria-label="Search customers"
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 pl-9 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E]"
        />
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {isPending ? 'Searching…' : 'Search'}
      </button>
      {q && (
        <button
          type="button"
          onClick={() => { setQ(''); submit(''); }}
          className="text-sm text-gray-500 hover:text-gray-800"
        >
          Clear
        </button>
      )}
    </form>
  );
}
