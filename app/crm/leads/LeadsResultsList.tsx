'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { formatDateTime, formatRand } from '@/app/admin/_lib/format';
import { bulkAssignOwner } from './actions';
import type { LeadScore } from '@/lib/crm/priorityScore';

export type LeadRow = {
  id: string;
  practice_name: string;
  contact_first_name: string;
  contact_last_name: string;
  phone: string | null;
  email: string | null;
  stage: string;
  specialty: string | null;
  suburb: string | null;
  city: string | null;
  next_follow_up_at: string | null;
  updated_at: string;
  estimated_monthly_billings: number | null;
};

// ─── Results table + mobile cards + bulk "assign to" ──────────────────
//
// Selection state is client-only (row checkboxes), scoped to the
// current filtered/sorted result set. bulkAssignOwner enforces the
// real rule via RLS — a sales caller's assign only actually touches
// rows they own, so `updated` can come back lower than the selection
// count without that being an error.

export default function LeadsResultsList({
  rows, owners, scores,
}: {
  rows: LeadRow[];
  owners: Array<{ id: string; name: string }>;
  scores?: Record<string, LeadScore>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignTo, setAssignTo] = useState('');
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(prev => (prev.size === rows.length ? new Set() : new Set(rows.map(r => r.id))));
  }

  function commitAssign() {
    if (!assignTo || selected.size === 0) return;
    startTransition(async () => {
      const res = await bulkAssignOwner(Array.from(selected), assignTo);
      if (res.error) { setMsg(res.error); return; }
      const ownerName = owners.find(o => o.id === assignTo)?.name ?? 'owner';
      setMsg(`Assigned ${res.updated ?? 0} of ${selected.size} selected lead(s) to ${ownerName}.`);
      setSelected(new Set());
      setAssignTo('');
    });
  }

  return (
    <div className="space-y-3">
      {selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-xl border border-[#15A89E]/40 bg-[#15A89E]/5 px-3 py-2"
          data-testid="bulk-assign-bar"
        >
          <span className="text-xs font-medium text-[#13294B]">{selected.size} selected</span>
          <select
            value={assignTo}
            onChange={e => setAssignTo(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs"
            data-testid="bulk-assign-owner-select"
          >
            <option value="">Assign to…</option>
            {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button
            type="button"
            onClick={commitAssign}
            disabled={pending || !assignTo}
            className="rounded-lg bg-[#13294B] text-white px-3 py-1.5 text-xs font-medium disabled:opacity-60"
            data-testid="bulk-assign-submit"
          >
            {pending ? 'Assigning…' : 'Assign'}
          </button>
          <button type="button" onClick={() => setSelected(new Set())} disabled={pending} className="text-xs text-gray-500">
            Clear
          </button>
        </div>
      )}
      {msg && <div role="status" className="text-xs rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-gray-700">{msg}</div>}

      {/* Desktop table */}
      <div className="hidden md:block bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && selected.size === rows.length}
                    onChange={toggleAll}
                    aria-label="Select all"
                  />
                </th>
                {['Practice', 'Contact', 'Stage', 'Specialty', 'Value', 'Priority', 'Next follow-up', 'Updated'].map(h => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map(r => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      aria-label={`Select ${r.practice_name}`}
                      data-testid={`lead-select:${r.id}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/crm/leads/${r.id}`} className="text-gray-900 font-medium hover:underline">
                      {r.practice_name}
                    </Link>
                    {r.suburb && <div className="text-xs text-gray-500">{[r.suburb, r.city].filter(Boolean).join(', ')}</div>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    <div>{r.contact_first_name} {r.contact_last_name}</div>
                    {r.email && <div className="text-gray-500 truncate max-w-[220px]">{r.email}</div>}
                    {r.phone && <div className="text-gray-500">{r.phone}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs capitalize">
                      {r.stage.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">{r.specialty ?? '—'}</td>
                  <td className="px-4 py-3 text-xs text-gray-600 tabular-nums whitespace-nowrap" data-testid={`lead-value:${r.id}`}>
                    {r.estimated_monthly_billings != null ? formatRand(r.estimated_monthly_billings) : '—'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap" data-testid={`lead-priority:${r.id}`}>
                    {scores?.[r.id] && (
                      <span
                        className="inline-flex items-center gap-1.5 text-xs text-gray-600"
                        title={scores[r.id].reason}
                        data-testid={`lead-priority-reason:${r.id}`}
                      >
                        <span className="tabular-nums font-semibold text-gray-800">{scores[r.id].score}</span>
                        <span className="text-gray-400 truncate max-w-[160px]">{scores[r.id].reason}</span>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {r.next_follow_up_at
                      ? new Date(r.next_follow_up_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' })
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                    {formatDateTime(r.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {rows.map(r => (
          <div key={r.id} className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 hover:border-gray-300">
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={selected.has(r.id)}
                onChange={() => toggle(r.id)}
                aria-label={`Select ${r.practice_name}`}
                className="mt-1"
              />
              <Link href={`/crm/leads/${r.id}`} className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{r.practice_name}</p>
                    <p className="text-xs text-gray-500 truncate">{r.contact_first_name} {r.contact_last_name}</p>
                  </div>
                  <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs capitalize shrink-0">
                    {r.stage.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-gray-400 uppercase tracking-wide text-[10px]">Specialty</p>
                    <p className="text-gray-900 truncate">{r.specialty ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 uppercase tracking-wide text-[10px]">Next</p>
                    <p className="text-gray-900 tabular-nums">
                      {r.next_follow_up_at
                        ? new Date(r.next_follow_up_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'short' })
                        : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-400 uppercase tracking-wide text-[10px]">Value</p>
                    <p className="text-gray-900 tabular-nums" data-testid={`lead-value-mobile:${r.id}`}>
                      {r.estimated_monthly_billings != null ? formatRand(r.estimated_monthly_billings) : '—'}
                    </p>
                  </div>
                  {scores?.[r.id] && (
                    <div className="col-span-2" data-testid={`lead-priority-mobile:${r.id}`}>
                      <p className="text-gray-400 uppercase tracking-wide text-[10px]">Priority</p>
                      <p className="text-gray-900">
                        <span className="tabular-nums font-semibold">{scores[r.id].score}</span>
                        <span className="text-gray-500"> — {scores[r.id].reason}</span>
                      </p>
                    </div>
                  )}
                </div>
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
