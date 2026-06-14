'use client';

import { useState } from 'react';

// ─── PracticeApprovalRow ─────────────────────────────────────────────────────
//
// One row per practice in the admin approval queue. Surfaces every field
// an admin needs to decide approval:
//   • identity (name, specialty)
//   • full address
//   • PR (practice_registration_number) — optional at signup
//   • HPCSA numbers — practice-level + any aggregated from members
//   • provider count — drives the trading gate's "≥ 1 provider"
//   • banking completeness — bank_name + bank_account_number both present
//
// Approve / Suspend buttons fire the server actions passed down from the
// page. Buttons stay disabled while a request is in-flight; revalidatePath
// refreshes the row when the action returns.

export type PracticeRow = {
  id:                            string;
  name:                          string;
  specialty:                     string;
  status:                        string;
  practice_registration_number:  string | null;
  hpcsa_number:                  string | null;
  email:                         string;
  phone:                         string | null;
  address_line1:                 string | null;
  address_line2:                 string | null;
  suburb:                        string | null;
  city:                          string | null;
  practice_province:             string | null;
  postal_code:                   string | null;
  bank_name:                     string | null;
  bank_account_number:           string | null;
  branch_code:                   string | null;
  created_at:                    string;
  approved_at:                   string | null;
  approved_by:                   string | null;
};

type Props = {
  practice:        PracticeRow;
  providerCount:   number;
  memberHpcsas:    string[];
  approvePractice: (id: string) => Promise<{ error: string | null }>;
  suspendPractice: (id: string) => Promise<{ error: string | null }>;
};

function formatAddress(p: PracticeRow): string {
  const parts = [
    p.address_line1,
    p.address_line2,
    p.suburb,
    p.city,
    p.practice_province,
    p.postal_code,
  ].filter(Boolean);
  return parts.join(', ') || '—';
}

function bankingComplete(p: PracticeRow): boolean {
  return !!(p.bank_name && p.bank_account_number);
}

function Pill({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className={
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium '
        + (ok
          ? 'bg-green-50 text-green-700 border border-green-200'
          : 'bg-amber-50 text-amber-800 border border-amber-200')
      }
    >
      {ok ? '✓' : '○'} {label}
    </span>
  );
}

export default function PracticeApprovalRow({
  practice,
  providerCount,
  memberHpcsas,
  approvePractice,
  suspendPractice,
}: Props) {
  const [busy,   setBusy]   = useState<'approve' | 'suspend' | null>(null);
  const [error,  setError]  = useState<string | null>(null);

  async function handleApprove() {
    setBusy('approve'); setError(null);
    const result = await approvePractice(practice.id);
    setBusy(null);
    if (result.error) setError(result.error);
  }

  async function handleSuspend() {
    setBusy('suspend'); setError(null);
    const result = await suspendPractice(practice.id);
    setBusy(null);
    if (result.error) setError(result.error);
  }

  const allHpcsas = [practice.hpcsa_number, ...memberHpcsas].filter((h): h is string => !!h);
  const banking   = bankingComplete(practice);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-base font-semibold text-gray-900">{practice.name}</h2>
            <span className="text-xs text-gray-500">{practice.specialty}</span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Signed up {new Date(practice.created_at).toLocaleDateString()} · {practice.email}
            {practice.phone ? ` · ${practice.phone}` : ''}
          </p>
          {practice.approved_at && (
            <p className="mt-0.5 text-xs text-gray-400">
              First approved {new Date(practice.approved_at).toLocaleString()}
              {practice.approved_by ? ` (admin ${practice.approved_by.slice(0, 8)}…)` : ''}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 items-end">
          {practice.status === 'pending' && (
            <button
              type="button"
              onClick={handleApprove}
              disabled={busy !== null}
              data-testid={`approve-${practice.id}`}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>
          )}
          {practice.status === 'approved' && (
            <button
              type="button"
              onClick={handleSuspend}
              disabled={busy !== null}
              data-testid={`suspend-${practice.id}`}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-red-700 bg-white border border-red-200 hover:bg-red-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {busy === 'suspend' ? 'Suspending…' : 'Suspend'}
            </button>
          )}
          {practice.status === 'suspended' && (
            <button
              type="button"
              onClick={handleApprove}
              disabled={busy !== null}
              data-testid={`reapprove-${practice.id}`}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              {busy === 'approve' ? 'Reactivating…' : 'Reactivate'}
            </button>
          )}
        </div>
      </div>

      {/* Compliance / completeness chips */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Pill label={`${providerCount} provider${providerCount === 1 ? '' : 's'}`} ok={providerCount > 0} />
        <Pill label="Banking" ok={banking} />
        <Pill label="PR" ok={!!practice.practice_registration_number} />
        <Pill label="HPCSA" ok={allHpcsas.length > 0} />
      </div>

      {/* Detail grid */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide">Address</p>
          <p className="text-gray-700">{formatAddress(practice)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide">PR (Practice Number)</p>
          <p className="text-gray-700">{practice.practice_registration_number || '—'}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide">HPCSA numbers</p>
          <p className="text-gray-700">
            {allHpcsas.length > 0 ? allHpcsas.join(', ') : '—'}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide">Banking</p>
          <p className="text-gray-700">
            {banking
              ? `${practice.bank_name} · …${(practice.bank_account_number ?? '').slice(-4)}`
              : 'Not yet provided'}
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
