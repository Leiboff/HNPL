'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import DateRangePicker from '@/app/practice/DateRangePicker';

// Thin URL-driven wrapper around the existing practice-dashboard
// DateRangePicker — reuses the exact same component (calendar UI,
// preset chips, hover preview) for visual / behavioural parity across
// the portal.
//
// State lives in the URL (`?from=YYYY-MM-DD&to=YYYY-MM-DD`) so the
// server can apply the range to the payments query, and links stay
// shareable. The `chip` param (and anything else already on the URL)
// is preserved on navigation.
//
// `onChange('', '')` from the picker (Clear) writes explicit empty
// values into the URL, which is the page's signal for "user cleared
// the range — do NOT fall back to the chip default".

type Props = {
  from: string;
  to:   string;
};

export default function CollectionsDateRangePicker({ from, to }: Props) {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function handleChange(nextFrom: string, nextTo: string) {
    const params = new URLSearchParams(searchParams.toString());
    // Always set both keys (even empty) so the server can distinguish
    // "user cleared the range" from "no params at all → use default".
    params.set('from', nextFrom);
    params.set('to',   nextTo);
    startTransition(() => {
      router.push(`/admin/collections?${params.toString()}`);
    });
  }

  return <DateRangePicker fromDate={from} toDate={to} onChange={handleChange} />;
}
