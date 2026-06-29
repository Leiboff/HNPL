'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

// ─── PracticeApprovalRow ─────────────────────────────────────────────────────
//
// Summary card for the approval queue. The full detail screen lives at
// /admin/practices/[id] — this row surfaces just enough info to decide
// whether to drill in.
//
// Each card carries a kebab (⋯) actions menu offering the
// status-appropriate options (View detail + Approve/Suspend/Reactivate
// depending on current status). The server actions enforce admin auth;
// the menu is presentation only.

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
  // Brand context — non-null only when the practice belongs to a brand
  // with >=2 practices (a multi-branch chain). Solo brands stay hidden
  // (matches the n=1 brand-invisible rule in the customer UX).
  brand:           { name: string; siblingCount: number } | null;
  approvePractice: (id: string) => Promise<{ error: string | null }>;
  suspendPractice: (id: string) => Promise<{ error: string | null }>;
};

function formatAddress(p: PracticeRow): string {
  const parts = [p.address_line1, p.suburb, p.city].filter(Boolean);
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

function KebabIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="12" cy="5"  r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="12" cy="19" r="1.75" />
    </svg>
  );
}

export default function PracticeApprovalRow({
  practice,
  providerCount,
  memberHpcsas,
  brand,
  approvePractice,
  suspendPractice,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy,     setBusy]     = useState<'approve' | 'suspend' | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Click-outside / Escape close.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown',   onKey);
    };
  }, [menuOpen]);

  async function run(kind: 'approve' | 'suspend') {
    setMenuOpen(false);
    setBusy(kind); setError(null);
    const fn = kind === 'approve' ? approvePractice : suspendPractice;
    const result = await fn(practice.id);
    setBusy(null);
    if (result.error) setError(result.error);
  }

  const allHpcsas = [practice.hpcsa_number, ...memberHpcsas].filter((h): h is string => !!h);
  const banking   = bankingComplete(practice);
  const detailHref = `/admin/practices/${practice.id}`;

  // Build the status-appropriate menu items.
  const menuItems: Array<{ label: string; onClick: () => void; danger?: boolean }> = [];
  if (practice.status === 'pending') {
    menuItems.push({ label: 'Approve',    onClick: () => run('approve') });
  } else if (practice.status === 'approved') {
    menuItems.push({ label: 'Suspend',    onClick: () => run('suspend'), danger: true });
  } else if (practice.status === 'suspended') {
    menuItems.push({ label: 'Reactivate', onClick: () => run('approve') });
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm">
      <Link
        href={detailHref}
        className="block px-4 sm:px-5 pt-5 pb-3 hover:bg-gray-50 transition-colors rounded-t-2xl"
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-base font-semibold text-gray-900 break-words">{practice.name}</h2>
              <span className="text-xs text-gray-500">{practice.specialty}</span>
              {brand && (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200"
                  title={`This practice is one of ${brand.siblingCount} under the ${brand.name} brand.`}
                >
                  Brand: {brand.name} · {brand.siblingCount} locations
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {formatAddress(practice)}
            </p>
            <p className="mt-0.5 text-xs text-gray-400">
              Signed up {new Date(practice.created_at).toLocaleDateString()} · {practice.email}
            </p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Pill label={`${providerCount} provider${providerCount === 1 ? '' : 's'}`} ok={providerCount > 0} />
          <Pill label="Banking" ok={banking} />
          <Pill label="PR" ok={!!practice.practice_registration_number} />
          <Pill label="HPCSA" ok={allHpcsas.length > 0} />
        </div>
      </Link>

      {/* Action bar — kebab + busy/error states. Sits BELOW the link so
          the entire summary card is one big tap target on mobile while
          the menu trigger stays operable. */}
      <div className="px-4 sm:px-5 pb-4 pt-1 border-t border-gray-100 flex items-center justify-between gap-3">
        <Link
          href={detailHref}
          className="text-sm font-medium text-[#15A89E] hover:text-[#13294B] transition-colors"
        >
          View detail →
        </Link>

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            disabled={busy !== null || menuItems.length === 0}
            data-testid={`row-kebab-${practice.id}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Actions"
          >
            <KebabIcon />
          </button>

          {menuOpen && (
            <div
              role="menu"
              data-testid={`row-menu-${practice.id}`}
              className="absolute right-0 top-full mt-1.5 z-20 min-w-[180px] rounded-xl border border-gray-200 bg-white shadow-lg py-1"
            >
              <Link
                role="menuitem"
                href={detailHref}
                className="block px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                onClick={() => setMenuOpen(false)}
              >
                View detail
              </Link>
              {menuItems.length > 0 && <div className="my-1 border-t border-gray-100" />}
              {menuItems.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  onClick={item.onClick}
                  data-testid={`row-action-${item.label.toLowerCase()}-${practice.id}`}
                  className={[
                    'w-full text-left px-4 py-2.5 text-sm transition-colors',
                    item.danger
                      ? 'text-red-700 hover:bg-red-50'
                      : 'text-gray-700 hover:bg-gray-50',
                  ].join(' ')}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Busy / error feedback below the action bar. */}
      {(busy || error) && (
        <div className="px-4 sm:px-5 pb-4 -mt-2">
          {busy && <p className="text-xs text-gray-500">Updating…</p>}
          {error && (
            <p role="alert" className="text-xs text-red-700 mt-1">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
