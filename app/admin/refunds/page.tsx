import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { paystackRequest } from '@/lib/paystack';
import LogoutButton from '@/app/dashboard/LogoutButton';
import { ActionButton } from '@/app/admin/OpsActions';

// ─── Types ────────────────────────────────────────────────────────────────────

type ProfileRef = { first_name: string; last_name: string };

type RefundRow = {
  id:                    string;
  transaction_reference: string;
  patient_id:            string | null;
  amount_cents:          number;
  reason:                string | null;
  status:                string;
  paystack_refund_id:    string | null;
  initiated_at:          string;
  processed_at:          string | null;
  last_event_at:         string | null;
  failure_reason:        string | null;
  profiles:              ProfileRef | ProfileRef[] | null;
};

type PaystackRefundResponse = {
  status:  boolean;
  message: string;
  data?: { id?: number; status?: string };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function formatRand(cents: number): string {
  const rands = cents / 100;
  const [integer, decimal] = rands.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

function patientName(p: ProfileRef | ProfileRef[] | null): string {
  const ref = Array.isArray(p) ? p[0] : p;
  if (!ref) return '—';
  return `${ref.first_name} ${ref.last_name}`;
}

function isOlderThan(iso: string, hours: number): boolean {
  return new Date(iso).getTime() < Date.now() - hours * 60 * 60 * 1000;
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

async function verifyAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase: null, error: 'Not authenticated.' } as const;
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (p?.role !== 'admin') return { supabase: null, error: 'Unauthorized.' } as const;
  return { supabase, error: null } as const;
}

// ─── Server actions ───────────────────────────────────────────────────────────

async function retryRefund(refundId: string): Promise<{ error: string | null }> {
  'use server';
  const { supabase, error: authError } = await verifyAdmin();
  if (authError) return { error: authError };

  const { data: refund } = await supabase!
    .from('refunds')
    .select('id, transaction_reference, status')
    .eq('id', refundId)
    .eq('status', 'failed')
    .maybeSingle();

  if (!refund) return { error: 'Refund not found or not in failed status.' };

  try {
    const refundRes = await paystackRequest<PaystackRefundResponse>('/refund', {
      method: 'POST',
      body:   JSON.stringify({ transaction: refund.transaction_reference }),
    });
    const paystackRefundId = refundRes.data?.id ? String(refundRes.data.id) : null;

    const { error: updateError } = await supabase!
      .from('refunds')
      .update({
        status:             'pending',
        paystack_refund_id: paystackRefundId,
        failure_reason:     null,
        last_event_at:      new Date().toISOString(),
      })
      .eq('id', refundId);

    if (updateError) return { error: updateError.message };

    console.log('[admin] retryRefund: retry initiated', { refundId, txRef: refund.transaction_reference });
    revalidatePath('/admin/refunds');
    return { error: null };
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : 'Unknown error';
    await supabase!
      .from('refunds')
      .update({ failure_reason: failureReason, last_event_at: new Date().toISOString() })
      .eq('id', refundId);
    return { error: failureReason };
  }
}

// ─── UI components ────────────────────────────────────────────────────────────

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  initiated:     { label: 'Initiated',     cls: 'bg-amber-100 text-amber-700' },
  pending:       { label: 'Pending',       cls: 'bg-amber-100 text-amber-700' },
  processed:     { label: 'Processed',     cls: 'bg-green-100 text-green-700' },
  failed:        { label: 'Failed',        cls: 'bg-red-100   text-red-700'   },
  manual_review: { label: 'Manual review', cls: 'bg-red-100   text-red-700'   },
};

function Badge({ status }: { status: string }) {
  const cfg = STATUS_CFG[status] ?? { label: status, cls: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-3">
      <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">{title}</h2>
      <span className="text-xs text-gray-400">{count} row{count !== 1 ? 's' : ''}</span>
    </div>
  );
}

function TH({ children }: { children: ReactNode }) {
  return (
    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap border-b border-gray-100 bg-white">
      {children}
    </th>
  );
}

function RefundTable({
  refunds,
  showRetry = false,
  highlightOld = false,
}: {
  refunds: RefundRow[];
  showRetry?: boolean;
  highlightOld?: boolean;
}) {
  if (refunds.length === 0) {
    return <p className="px-5 py-8 text-sm text-gray-400">None.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <TH>Reference</TH>
            <TH>Patient</TH>
            <TH>Amount</TH>
            <TH>Reason</TH>
            <TH>Status</TH>
            <TH>Initiated</TH>
            <TH>Last event</TH>
            {showRetry && <TH>Action</TH>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {refunds.map((r) => {
            const veryOld = highlightOld && isOlderThan(r.initiated_at, 24);
            return (
              <tr
                key={r.id}
                className={`hover:bg-gray-50 transition-colors ${veryOld ? 'bg-red-50' : ''}`}
              >
                <td className="px-4 py-2.5 whitespace-nowrap">
                  <span className="font-mono text-xs text-gray-700">{r.transaction_reference}</span>
                  {r.paystack_refund_id && (
                    <span className="block text-xs text-gray-400 mt-0.5">
                      Paystack ID: {r.paystack_refund_id}
                    </span>
                  )}
                  {veryOld && (
                    <span className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-red-600 uppercase tracking-wide">
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
                        <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                      </svg>
                      Outstanding &gt;24h
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">
                  {patientName(r.profiles)}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-gray-900 whitespace-nowrap">
                  {formatRand(r.amount_cents)}
                </td>
                <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">
                  {r.reason ?? '—'}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  <Badge status={r.status} />
                  {r.failure_reason && (
                    <span className="block text-xs text-red-600 mt-0.5 max-w-[200px] truncate" title={r.failure_reason}>
                      {r.failure_reason}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap text-xs">
                  {formatDateTime(r.initiated_at)}
                </td>
                <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap text-xs">
                  {r.last_event_at ? formatDateTime(r.last_event_at) : '—'}
                </td>
                {showRetry && (
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <ActionButton
                      id={r.id}
                      label="Retry"
                      loadingLabel="Retrying…"
                      action={retryRefund}
                      variant="blue"
                    />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function AdminRefundsPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin/refunds' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    if (profile?.role === 'patient') redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else redirect('/login');
  }

  const oneHourAgo  = new Date(Date.now() -  1 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: rawOutstanding },
    { data: rawProcessed },
    { data: rawFailed },
  ] = await Promise.all([
    supabase
      .from('refunds')
      .select('*, profiles(first_name, last_name)')
      .in('status', ['initiated', 'pending'])
      .lt('initiated_at', oneHourAgo)
      .order('initiated_at', { ascending: true }),
    supabase
      .from('refunds')
      .select('*, profiles(first_name, last_name)')
      .eq('status', 'processed')
      .gte('processed_at', sevenDaysAgo)
      .order('processed_at', { ascending: false }),
    supabase
      .from('refunds')
      .select('*, profiles(first_name, last_name)')
      .in('status', ['failed', 'manual_review'])
      .order('initiated_at', { ascending: false }),
  ]);

  const outstanding = (rawOutstanding ?? []) as unknown as RefundRow[];
  const processed   = (rawProcessed   ?? []) as unknown as RefundRow[];
  const failed      = (rawFailed      ?? []) as unknown as RefundRow[];

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="mx-auto max-w-7xl px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="text-base font-semibold text-gray-900 hover:text-gray-700 transition-colors">
              BetterNow
            </Link>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide border border-gray-200 rounded px-1.5 py-0.5">
              Ops
            </span>
            <span className="text-gray-300">/</span>
            <span className="text-sm font-medium text-gray-600">Refunds</span>
          </div>
          <LogoutButton />
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8 space-y-8 pb-16">

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Refund Tracking</h1>
            <p className="mt-0.5 text-sm text-gray-500">
              Card-registration R1 refunds — initiated, in-flight, and completed.
            </p>
          </div>
          <Link
            href="/admin"
            className="text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors"
          >
            ← Back to operations
          </Link>
        </div>

        {/* ── Outstanding (>1 h, not yet processed) ── */}
        <div className="bg-white border border-amber-200 rounded-lg overflow-hidden">
          <SectionHeader title="Outstanding — awaiting confirmation" count={outstanding.length} />
          <RefundTable refunds={outstanding} highlightOld />
        </div>

        {/* ── Failed / needs manual review ── */}
        <div className="bg-white border border-red-200 rounded-lg overflow-hidden">
          <SectionHeader title="Failed / needs review" count={failed.length} />
          <RefundTable refunds={failed} showRetry />
        </div>

        {/* ── Recently processed ── */}
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <SectionHeader title="Recently processed (last 7 days)" count={processed.length} />
          <RefundTable refunds={processed} />
        </div>

      </main>
    </div>
  );
}
