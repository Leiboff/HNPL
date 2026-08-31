'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { formatRand } from '@/app/practice/billHelpers';
import type { RevenueSummary } from '@/lib/brand/revenue';

// ─── Revenue dashboard — client surface (net-only) ─────────────────────
//
// The whole brand surface is net-only: the practice's own revenue
// ledger from an activated bill (gross − commission). Practice +
// doctor filters remain URL params for shareable links.
//
// What is intentionally NOT here: collection-progress (settled-so-far,
// remaining instalments, processor charge state). The provider sees activated-
// plan net-to-provider only; collection is BetterNow's float position.
//
// MONEY IS FORMATTED BY THE SHARED formatRand, NEVER LOCALLY
// ─────────────────────────────────────────────────────────
// This screen used to carry its own one-line helper:
//
//   v.toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR',
//                               maximumFractionDigits: 0 })
//
// which rendered R14,180.55 as "R 14 181" — and the brand Overview, using
// the shared formatter, rendered the SAME figure as "R14,180.55". Three
// separate divergences in one line: the cents were rounded away, the
// thousands separator was a non-breaking space rather than a comma, and
// there was a space after the R.
//
// That is not a styling difference. Both screens describe money a practice
// reconciles against a bank deposit, so a reader comparing them cannot tell
// a formatting choice from a shortfall — they see two different amounts for
// one payment and have no way to know which is real. Rounding is the worst
// of the three: it is silent, and it is wrong by up to 50c on every figure,
// including the headline total.
//
// So there is no local money formatter here any more, and the source pins in
// brandRevenueMoney.test.ts assert that none comes back. Intl currency
// formatting in particular is banned on money surfaces: its output depends on
// the ICU build the code happens to be running against, which is not a
// property a reconcilable figure may have.

type Props = {
  summary:            RevenueSummary;
  practices:          Array<{ id: string; name: string }>;
  providers:          Array<{ id: string; fullName: string }>;
  selectedPracticeId: string | null;
  selectedProviderId: string | null;
};

export default function RevenueClient({
  summary,
  practices,
  providers,
  selectedPracticeId,
  selectedProviderId,
}: Props) {
  const router       = useRouter();
  const searchParams = useSearchParams();

  function setFilter(key: 'practice' | 'provider', value: string | null) {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (value) params.set(key, value);
    else       params.delete(key);
    router.push(`/brand/revenue?${params.toString()}`);
  }

  return (
    <div className="space-y-6">
      {/* ── Filters ─────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-5 py-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Filters</p>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-600 w-20 shrink-0">Practice</label>
            <select
              value={selectedPracticeId ?? ''}
              onChange={(e) => setFilter('practice', e.target.value || null)}
              data-testid="filter-practice"
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900"
            >
              <option value="">All practices</option>
              {practices.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-600 w-20 shrink-0">Doctor</label>
            <select
              value={selectedProviderId ?? ''}
              onChange={(e) => setFilter('provider', e.target.value || null)}
              data-testid="filter-provider"
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900"
            >
              <option value="">All doctors</option>
              {providers.map((d) => (
                <option key={d.id} value={d.id}>{d.fullName}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ── Headline figure (net) ───────────────────────────────────── */}
      <div className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-5 py-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
          Net to provider (after commission)
        </p>
        <p className="mt-2 text-3xl font-semibold" style={{ color: 'var(--portal-ink)' }} data-testid="revenue-headline">
          {formatRand(summary.totalNet)}
        </p>
        <p className="mt-1 text-xs text-gray-500">
          {summary.totalCount} active plan{summary.totalCount === 1 ? '' : 's'}. Net of BetterNow&apos;s commission.
        </p>
      </div>

      {/* ── Breakdown: by practice ───────────────────────────────── */}
      <BreakdownTable
        title="By practice"
        rows={summary.byPractice}
        emptyMessage="No active plans match the current filters."
        testIdPrefix="row-practice"
      />

      {/* ── Breakdown: by doctor ─────────────────────────────────── */}
      <BreakdownTable
        title="By doctor"
        rows={summary.byProvider}
        emptyMessage="No active plans attributed to a doctor under the current filters."
        testIdPrefix="row-provider"
      />
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
  emptyMessage,
  testIdPrefix,
}: {
  title:        string;
  rows:         RevenueSummary['byPractice'];
  emptyMessage: string;
  testIdPrefix: string;
}) {
  return (
    <section className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm">
      <header className="px-5 py-3 border-b border-gray-100">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">{title}</p>
      </header>
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-gray-500">{emptyMessage}</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rows.map((r) => (
            <li
              key={r.id}
              data-testid={`${testIdPrefix}-${r.id}`}
              className="flex items-center justify-between gap-3 px-5 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{r.label}</p>
                <p className="text-xs text-gray-500">
                  {r.count} active plan{r.count === 1 ? '' : 's'}
                </p>
              </div>
              <p className="text-sm font-semibold" style={{ color: 'var(--portal-ink)' }}>
                {formatRand(r.net)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
