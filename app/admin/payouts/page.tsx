import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { ActionButton } from '../OpsActions';
import { formatRand, formatDateTime, fullName, practiceName } from '../_lib/format';
import { markPayoutPaid } from './actions';

// ─── /admin/payouts ─────────────────────────────────────────────────────────
//
// All payouts owed to practices: pending (HNPL owes the practice) and
// paid (settled). "Mark paid" is a bookkeeping flip — the actual payout
// happens via Paystack/banking outside the app.

type NameRef     = { first_name: string; last_name: string };
type PracticeRef = { name: string };
type PlanProfileRef = { invoice_number: string | null; profiles: NameRef | NameRef[] | null };

type PayoutRow = {
  id:           string;
  gross_amount: number;
  fee_amount:   number;
  net_amount:   number;
  status:       string;
  created_at:   string;
  practices:    PracticeRef | PracticeRef[] | null;
  plans:        PlanProfileRef | PlanProfileRef[] | null;
};

const PAYOUT_CFG: Record<string, { label: string; cls: string }> = {
  pending:    { label: 'Pending',    cls: 'bg-amber-100 text-amber-700' },
  processing: { label: 'Processing', cls: 'bg-blue-100  text-blue-700'  },
  paid:       { label: 'Paid',       cls: 'bg-green-100 text-green-700' },
  failed:     { label: 'Failed',     cls: 'bg-red-100   text-red-700'   },
};

function invoiceFromPlans(plans: PlanProfileRef | PlanProfileRef[] | null): string {
  const p = Array.isArray(plans) ? plans[0] : plans;
  return p?.invoice_number ?? '—';
}

function patientFromPlans(plans: PlanProfileRef | PlanProfileRef[] | null): string {
  const p = Array.isArray(plans) ? plans[0] : plans;
  if (!p) return '—';
  return fullName(p.profiles);
}

export default async function AdminPayoutsPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin/payouts' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  const { data: rawPayouts } = await supabase
    .from('payouts')
    .select(`
      id, gross_amount, fee_amount, net_amount, status, created_at,
      practices(name),
      plans(invoice_number, profiles!plans_patient_id_fkey(first_name, last_name))
    `)
    .order('created_at', { ascending: false })
    .limit(500);

  const payouts = (rawPayouts ?? []) as unknown as PayoutRow[];
  const pending = payouts.filter(p => p.status === 'pending');
  const settled = payouts.filter(p => p.status !== 'pending');

  const totalPending = pending.reduce((s, p) => s + Number(p.net_amount), 0);
  const totalSettled = settled.reduce((s, p) => s + Number(p.net_amount), 0);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">

      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Payouts</h1>
        <p className="mt-1 text-sm text-gray-500">
          Money HNPL owes practices after collecting from patients.
          The actual payout is settled via banking outside the app — "Mark paid" is the bookkeeping flip.
        </p>
      </div>

      {/* Summary chips */}
      <div className="flex gap-3 flex-wrap text-sm">
        <div className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5">
          <span className="text-amber-800 font-medium">Pending: </span>
          <span className="tabular-nums text-amber-900 font-semibold">{formatRand(totalPending)}</span>
          <span className="ml-2 text-amber-700">({pending.length})</span>
        </div>
        <div className="rounded-full border border-green-200 bg-green-50 px-3 py-1.5">
          <span className="text-green-800 font-medium">Settled: </span>
          <span className="tabular-nums text-green-900 font-semibold">{formatRand(totalSettled)}</span>
          <span className="ml-2 text-green-700">({settled.length})</span>
        </div>
      </div>

      {/* Pending */}
      <section className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-4 sm:px-5 py-3 bg-gray-50 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900">Pending payouts</h2>
        </div>
        {pending.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">No pending payouts.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white border-b border-gray-100">
                <tr>
                  {['Practice', 'Patient', 'Invoice', 'Gross', 'Fee', 'Net', 'Created', 'Action'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pending.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900 whitespace-nowrap">{practiceName(p.practices)}</td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{patientFromPlans(p.plans)}</td>
                    <td className="px-4 py-3 text-gray-700 font-mono text-xs whitespace-nowrap">{invoiceFromPlans(p.plans)}</td>
                    <td className="px-4 py-3 text-gray-700 tabular-nums whitespace-nowrap">{formatRand(Number(p.gross_amount))}</td>
                    <td className="px-4 py-3 text-gray-500 tabular-nums whitespace-nowrap">−{formatRand(Number(p.fee_amount))}</td>
                    <td className="px-4 py-3 text-gray-900 tabular-nums whitespace-nowrap font-semibold">{formatRand(Number(p.net_amount))}</td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDateTime(p.created_at)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <ActionButton
                        id={p.id}
                        label="Mark paid"
                        loadingLabel="Marking…"
                        action={markPayoutPaid}
                        variant="green"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Settled */}
      <section className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-4 sm:px-5 py-3 bg-gray-50 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900">Settled payouts</h2>
        </div>
        {settled.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">No settled payouts yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white border-b border-gray-100">
                <tr>
                  {['Practice', 'Patient', 'Invoice', 'Net', 'Status', 'Created'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {settled.map((p) => {
                  const cfg = PAYOUT_CFG[p.status] ?? { label: p.status, cls: 'bg-gray-100 text-gray-600' };
                  return (
                    <tr key={p.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-900 whitespace-nowrap">{practiceName(p.practices)}</td>
                      <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{patientFromPlans(p.plans)}</td>
                      <td className="px-4 py-3 text-gray-700 font-mono text-xs whitespace-nowrap">{invoiceFromPlans(p.plans)}</td>
                      <td className="px-4 py-3 text-gray-900 tabular-nums whitespace-nowrap font-semibold">{formatRand(Number(p.net_amount))}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cfg.cls}`}>
                          {cfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDateTime(p.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
