'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { STAGES } from '@/lib/crm/stages';
import { INTERESTS, INTEREST_LABELS } from '@/lib/crm/interest';

// ─── Filter dropdowns — Stage / Source / Specialty / City / Owner ─────
//
// Each is a plain <select>; picking a value updates the URL (so it
// stays linkable and survives the List/Map switch) without a page
// reload. Rendered inside LeadsToolbar's Filter sheet (layout=
// "stacked", one per row with a visible label) — kept generic enough
// to also render as a compact inline row (layout="row", the default)
// if some other surface wants it that way.

const SOURCES = ['referral','cold_outreach','inbound','event','other'] as const;

function Field({ label, stacked, children }: { label: string; stacked: boolean; children: React.ReactNode }) {
  if (!stacked) return <>{children}</>;
  return (
    <label className="block text-xs">
      <span className="block font-medium text-gray-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

export default function LeadsFilterDropdowns({
  specialties, cities, owners, isAdmin, currentUserId, layout = 'row',
}: {
  specialties: readonly string[];
  cities: string[];
  owners: Array<{ id: string; name: string }>;
  isAdmin: boolean;
  currentUserId: string;
  layout?: 'row' | 'stacked';
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value); else params.delete(key);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const stacked = layout === 'stacked';
  const selectCls = stacked
    ? 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E]'
    : 'rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E]';

  return (
    <div className={stacked ? 'space-y-3' : 'flex gap-2 flex-wrap items-center'} data-testid="leads-filter-dropdowns">
      <Field label="Stage" stacked={stacked}>
        <select
          className={selectCls}
          value={searchParams.get('stage') ?? ''}
          onChange={e => setParam('stage', e.target.value)}
          data-testid="filter-stage"
          aria-label="Filter by stage"
        >
          <option value="">All stages</option>
          {STAGES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
      </Field>

      <Field label="Source" stacked={stacked}>
        <select
          className={selectCls}
          value={searchParams.get('source') ?? ''}
          onChange={e => setParam('source', e.target.value)}
          data-testid="filter-source"
          aria-label="Filter by source"
        >
          <option value="">All sources</option>
          {SOURCES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
      </Field>

      <Field label="Specialty" stacked={stacked}>
        <select
          className={selectCls}
          value={searchParams.get('specialty') ?? ''}
          onChange={e => setParam('specialty', e.target.value)}
          data-testid="filter-specialty"
          aria-label="Filter by specialty"
        >
          <option value="">All specialties</option>
          {specialties.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>

      <Field label="Interest" stacked={stacked}>
        <select
          className={selectCls}
          value={searchParams.get('interest') ?? ''}
          onChange={e => setParam('interest', e.target.value)}
          data-testid="filter-interest"
          aria-label="Filter by interest"
        >
          <option value="">All interest levels</option>
          {INTERESTS.map(i => <option key={i} value={i}>{INTEREST_LABELS[i]}</option>)}
        </select>
      </Field>

      {cities.length > 0 && (
        <Field label="City" stacked={stacked}>
          <select
            className={selectCls}
            value={searchParams.get('city') ?? ''}
            onChange={e => setParam('city', e.target.value)}
            data-testid="filter-city"
            aria-label="Filter by city"
          >
            <option value="">All cities</option>
            {cities.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
      )}

      {isAdmin && owners.length > 0 && (
        <Field label="Owner" stacked={stacked}>
          <select
            className={selectCls}
            value={searchParams.get('owner') ?? ''}
            onChange={e => setParam('owner', e.target.value)}
            data-testid="filter-owner"
            aria-label="Filter by owner"
          >
            <option value="">All owners</option>
            <option value="me">My leads</option>
            {owners.filter(o => o.id !== currentUserId).map(o => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </Field>
      )}

      <label className={'inline-flex items-center gap-1.5 text-xs text-gray-700 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 ' + (stacked ? 'w-full py-2' : '')}>
        <input
          type="checkbox"
          checked={searchParams.get('overdue') === 'true'}
          onChange={e => setParam('overdue', e.target.checked ? 'true' : '')}
          data-testid="filter-overdue"
        />
        Overdue only
      </label>
    </div>
  );
}
