'use client';

import { useState, useRef, useEffect } from 'react';
import { calculateFee } from '@/lib/finance';
import {
  PlanSummary,
  formatRand,
  formatDate,
  patientDisplay,
  providerName,
  getPayout,
  doctorStatus,
  formatLocalDate,
} from './billHelpers';

type Props = {
  plans:        PlanSummary[];   // already filtered by parent
  totalCount:   number;          // total before filtering
  hasFilters:   boolean;
  feePercent:   number;
  specialtyMap: Record<string, string>;
  practiceName: string;
};

function PlanStatusBadge({ status }: { status: string }) {
  const cfg = doctorStatus(status);
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function DotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3"  cy="8" r="1.5" />
      <circle cx="8"  cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

export default function BillsBlock({
  plans,
  totalCount,
  hasFilters,
  feePercent,
  specialtyMap,
  practiceName,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  function handleExportCSV() {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const headers = ['Invoice', 'Ref', 'Patient', 'Provider', 'Specialty', 'Bill (R)', 'Fee (R)', 'Net (R)', 'Status', 'Payout', 'Date'];
    const rows = plans.map((plan) => {
      const { fee, net } = calculateFee(Number(plan.total_amount), feePercent);
      const payout = getPayout(plan);
      const payoutLabel = plan.status === 'pending_acceptance'
        ? 'Not yet accepted'
        : payout?.status === 'paid' ? 'Paid' : payout ? 'Pending' : '';
      return [
        plan.invoice_number ?? '',
        plan.practice_reference ?? '',
        patientDisplay(plan),
        providerName(plan),
        plan.provider_id ? (specialtyMap[plan.provider_id] ?? '') : '',
        Number(plan.total_amount).toFixed(2),
        fee.toFixed(2),
        net.toFixed(2),
        doctorStatus(plan.status).label,
        payoutLabel,
        formatDate(plan.created_at),
      ].map(esc);
    });
    const csv  = [headers.map(esc), ...rows].map((r) => r.join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `bills-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setMenuOpen(false);
  }

  function handleExportPDF() {
    const tableRows = plans.map((plan) => {
      const { fee, net } = calculateFee(Number(plan.total_amount), feePercent);
      const payout = getPayout(plan);
      const payoutLabel = plan.status === 'pending_acceptance'
        ? 'Not yet accepted'
        : payout?.status === 'paid' ? 'Paid' : payout ? 'Pending' : '—';
      return `<tr>
        <td>${plan.invoice_number ?? '—'}${plan.practice_reference ? `<br><small>${plan.practice_reference}</small>` : ''}</td>
        <td>${patientDisplay(plan)}</td>
        <td>${providerName(plan)}</td>
        <td>${plan.provider_id ? (specialtyMap[plan.provider_id] ?? '—') : '—'}</td>
        <td>R${Number(plan.total_amount).toFixed(2)}</td>
        <td>-R${fee.toFixed(2)}</td>
        <td>R${net.toFixed(2)}</td>
        <td>${doctorStatus(plan.status).label}</td>
        <td>${payoutLabel}</td>
        <td>${formatDate(plan.created_at)}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${practiceName} — Bills</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 11px; color: #111; margin: 0; padding: 24px; }
  h1   { font-size: 15px; font-weight: 600; margin: 0 0 3px; }
  .meta { font-size: 10px; color: #6b7280; margin: 0 0 18px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #f9fafb; text-align: left; padding: 6px 8px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; border-bottom: 1px solid #e5e7eb; white-space: nowrap; }
  td { padding: 6px 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  small { color: #9ca3af; }
  @media print { @page { margin: 14mm; size: A4 landscape; } }
</style></head><body>
  <h1>${practiceName}</h1>
  <p class="meta">Bills export · Generated ${formatDate(new Date().toISOString())}</p>
  <table><thead><tr>
    <th>Invoice / Ref</th><th>Patient</th><th>Provider</th><th>Specialty</th>
    <th>Bill</th><th>Fee</th><th>Net</th><th>Status</th><th>Payout</th><th>Date</th>
  </tr></thead><tbody>${tableRows}</tbody></table>
</body></html>`;

    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(html);
    win.document.close();
    setTimeout(() => { win.focus(); win.print(); }, 350);
    setMenuOpen(false);
  }

  return (
    <div className="bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm">

      {/* Header */}
      <div className="px-4 sm:px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Recent bills</h2>
          {hasFilters && (
            <p className="text-xs text-gray-400 mt-0.5">
              {plans.length} of {totalCount} bill{totalCount !== 1 ? 's' : ''}
            </p>
          )}
        </div>

        {totalCount > 0 && (
          <div className="flex items-center gap-3">
            <a
              href="/practice/bills/new"
              className="text-sm font-medium text-[#15A89E] hover:text-[#13294B] transition-colors"
            >
              + New bill
            </a>
            <div ref={menuRef} className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                title="Export"
                aria-expanded={menuOpen}
              >
                <DotsIcon />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1.5 bg-white rounded-xl border border-gray-200 shadow-lg py-1 z-20 min-w-[160px]">
                  <button onClick={handleExportCSV} className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5 transition-colors">
                    <span className="text-gray-400"><DownloadIcon /></span> Export CSV
                  </button>
                  <button onClick={handleExportPDF} className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5 transition-colors">
                    <span className="text-gray-400"><FileIcon /></span> Export PDF
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="overflow-hidden rounded-b-2xl">
        {totalCount === 0 ? (
          <div className="py-20 text-center">
            <p className="font-medium text-gray-500">No bills yet</p>
            <p className="mt-1 text-sm text-gray-400">Create your first bill to get started.</p>
            <a
              href="/practice/bills/new"
              className="mt-5 inline-block rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              Create a bill
            </a>
          </div>
        ) : plans.length === 0 ? (
          <div className="py-16 text-center">
            <p className="font-medium text-gray-500">No bills match your filters</p>
            <p className="mt-1 text-sm text-gray-400">Try adjusting the date range or provider.</p>
          </div>
        ) : (
          <>
            {/* ── Mobile cards (< md) ───────────────────────────── */}
            <div className="md:hidden divide-y divide-gray-100">
              {plans.map((plan) => {
                const payout    = getPayout(plan);
                const isPending = plan.status === 'pending_acceptance';
                return (
                  <div key={plan.id} className="px-5 py-4 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 truncate">{patientDisplay(plan)}</p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <PlanStatusBadge status={plan.status} />
                        {!isPending && payout && (
                          <span className={`text-xs font-medium ${payout.status === 'paid' ? 'text-green-700' : 'text-amber-700'}`}>
                            {payout.status === 'paid' ? 'Paid out' : 'Payout pending'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-semibold tabular-nums text-gray-900">{formatRand(Number(plan.total_amount))}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{formatDate(plan.created_at)}</p>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── Desktop table (md+) ────────────────────────────── */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left bg-gray-50">
                    {['Reference','Patient','Provider','Specialty','Bill','Fee','Net payout','Status','Payout','Created'].map((h) => (
                      <th key={h} className="px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {plans.map((plan) => {
                    const payout    = getPayout(plan);
                    const isPending = plan.status === 'pending_acceptance';
                    const { fee, net } = calculateFee(Number(plan.total_amount), feePercent);
                    return (
                      <tr key={plan.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="block font-mono text-xs text-gray-700">{plan.invoice_number ?? '—'}</span>
                          {plan.practice_reference && (
                            <span className="block text-xs text-gray-400 mt-0.5">Ref: {plan.practice_reference}</span>
                          )}
                        </td>
                        <td className="px-6 py-4 font-medium text-gray-900 whitespace-nowrap">{patientDisplay(plan)}</td>
                        <td className="px-6 py-4 text-gray-700 whitespace-nowrap">{providerName(plan)}</td>
                        <td className="px-6 py-4 text-gray-500 whitespace-nowrap text-xs">
                          {plan.provider_id ? (specialtyMap[plan.provider_id] ?? '—') : '—'}
                        </td>
                        <td className="px-6 py-4 text-gray-700 whitespace-nowrap tabular-nums">{formatRand(Number(plan.total_amount))}</td>
                        <td className="px-6 py-4 whitespace-nowrap tabular-nums">
                          <span className={isPending ? 'text-gray-400' : 'text-gray-700'}>−{formatRand(fee)}</span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap tabular-nums">
                          <span className={`font-medium ${isPending ? 'text-gray-400' : 'text-gray-900'}`}>{formatRand(net)}</span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap"><PlanStatusBadge status={plan.status} /></td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {isPending ? (
                            <span className="text-xs text-gray-400">Not yet accepted</span>
                          ) : payout ? (
                            <span className={`text-xs font-medium ${
                              payout.status === 'paid'       ? 'text-green-700' :
                              payout.status === 'processing' ? 'text-blue-700'  :
                              payout.status === 'failed'     ? 'text-red-600'   : 'text-amber-700'
                            }`}>{payout.status === 'paid' ? 'Paid' : 'Pending'}</span>
                          ) : <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-6 py-4 text-gray-500 whitespace-nowrap">{formatDate(plan.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
