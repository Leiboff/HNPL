import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

type PatientRef = { first_name: string; last_name: string };
type PayoutRef  = { net_amount: number; status: string };

type ProviderPlan = {
  id:                 string;
  total_amount:       number;
  status:             string;
  created_at:         string;
  invoice_number:     string | null;
  practice_reference: string | null;
  profiles:           PatientRef | PatientRef[] | null;
  payouts:            PayoutRef  | PayoutRef[]  | null;
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatRand(n: number): string {
  const [int, dec] = n.toFixed(2).split('.');
  return `R${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

function patientDisplay(p: PatientRef | PatientRef[] | null): string {
  const ref = Array.isArray(p) ? p[0] : p;
  if (!ref) return '—';
  return `${ref.first_name} ${ref.last_name.charAt(0)}.`;
}

function getPayout(p: PayoutRef | PayoutRef[] | null): PayoutRef | null {
  if (!p) return null;
  return Array.isArray(p) ? (p[0] ?? null) : p;
}

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, string> = {
    pending_acceptance: 'bg-amber-100 text-amber-800',
    active:             'bg-green-100 text-green-700',
    completed:          'bg-green-100 text-green-700',
    cancelled:          'bg-gray-100 text-gray-400',
    defaulted:          'bg-red-100 text-red-700',
  };
  const label: Record<string, string> = {
    pending_acceptance: 'Awaiting patient',
    active:             'Active',
    completed:          'Completed',
    cancelled:          'Cancelled',
    defaulted:          'Defaulted',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {label[status] ?? status}
    </span>
  );
}

export default async function ProviderDashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [
    { data: plans },
    { data: payoutsData },
    { count: totalBilled },
  ] = await Promise.all([
    supabase
      .from('plans')
      .select('id, total_amount, status, created_at, invoice_number, practice_reference, profiles!plans_patient_id_fkey(first_name, last_name), payouts(net_amount, status)')
      .eq('provider_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('payouts')
      .select('net_amount, status')
      .eq('provider_id', user.id),
    supabase
      .from('plans')
      .select('*', { count: 'exact', head: true })
      .eq('provider_id', user.id),
  ]);

  const rows = (plans ?? []) as unknown as ProviderPlan[];

  const totalPaidOut = (payoutsData ?? []).reduce(
    (sum, p: any) => p.status === 'paid' ? sum + Number(p.net_amount) : sum, 0,
  );
  const pendingPayout = (payoutsData ?? []).reduce(
    (sum, p: any) => p.status === 'pending' ? sum + Number(p.net_amount) : sum, 0,
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">My Bills</h1>
        <p className="mt-1 text-sm text-gray-500">Plans assigned to you by your practice.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: 'Total bills',          value: String(totalBilled ?? 0), cls: 'bg-white border-gray-200 text-gray-900' },
          { label: 'Total paid out',       value: formatRand(totalPaidOut),  cls: 'bg-green-50 border-green-200 text-green-900' },
          { label: 'Pending payout',       value: formatRand(pendingPayout), cls: 'bg-blue-50  border-blue-200  text-blue-900'  },
        ].map(({ label, value, cls }) => (
          <div key={label} className={`rounded-2xl border shadow-sm p-5 ${cls}`}>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      {/* Plan list */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Payment plans</h2>
        </div>

        {rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-400">No bills assigned to you yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left">
                  {['Reference', 'Patient', 'Amount', 'Status', 'Payout', 'Date'].map(h => (
                    <th key={h} className="px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(plan => {
                  const payout = getPayout(plan.payouts);
                  return (
                    <tr key={plan.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="font-mono text-xs text-gray-700">{plan.invoice_number ?? '—'}</span>
                        {plan.practice_reference && (
                          <span className="block text-xs text-gray-400 mt-0.5">Ref: {plan.practice_reference}</span>
                        )}
                      </td>
                      <td className="px-6 py-4 font-medium text-gray-900 whitespace-nowrap">{patientDisplay(plan.profiles)}</td>
                      <td className="px-6 py-4 tabular-nums text-gray-700 whitespace-nowrap">{formatRand(Number(plan.total_amount))}</td>
                      <td className="px-6 py-4 whitespace-nowrap"><StatusBadge status={plan.status} /></td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {payout ? (
                          <span className={`text-xs font-medium capitalize ${payout.status === 'paid' ? 'text-green-700' : 'text-amber-700'}`}>
                            {payout.status === 'paid' ? 'Paid' : 'Pending'}
                          </span>
                        ) : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-6 py-4 text-gray-400 whitespace-nowrap text-xs">{formatDate(plan.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
