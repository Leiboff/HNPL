import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getRequestUser } from '@/lib/auth/requestUser';

// ─── A provider's own view ───────────────────────────────────────────────
//
// INFORMATIONAL ONLY: the bills this provider raised, who they were for, and
// where each one stands. Nothing else.
//
// Explicitly NOT here, and not by omission:
//   • No money owed to or paid to this provider. Payouts go to the PRACTICE
//     regardless of who treated the patient (the per-provider payout
//     destination was removed with migration 0090), so a per-provider money
//     figure would be describing something that does not exist. The
//     `payouts` join, the two aggregate cards and the "Payout" column were
//     all removed for that reason rather than relabelled again.
//   • No banking, team, or practice settings — see ./layout.tsx, whose nav
//     has only Dashboard and My profile.
//
// Bill AMOUNTS remain, because those are the provider's own clinical record:
// what was billed for their patient. That is not a payout figure.

type PatientRef = { first_name: string; last_name: string };

type ProviderPlan = {
  id:                 string;
  total_amount:       number;
  status:             string;
  created_at:         string;
  invoice_number:     string | null;
  practice_reference: string | null;
  profiles:           PatientRef | PatientRef[] | null;
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
  const user = await getRequestUser();
  if (!user) redirect('/login');

  // ── Scoping ───────────────────────────────────────────────────────────
  //
  // Since 0094 a plan is attributed to a practice_members row, not to an auth
  // user, so "my bills" is now "bills attributed to one of MY ACTIVE
  // memberships". That is resolved first and every read below is
  // `.in('provider_member_id', myActiveMemberIds)` — another provider's bills
  // at the same practice are not filtered out of a wider set, they are never
  // selected. There is no practice-wide query on this page and no practiceId
  // parameter to tamper with.
  //
  // Filtering the memberships on active = true is what revokes access: a plan
  // stays attributed to the practitioner who raised it forever, so a
  // deactivated membership must drop out of this list rather than keep
  // resolving. Under the old provider_id form that had to be a separate gate
  // (the id in the column carried no active flag); now it falls out of the
  // same query, and migration 0094 enforces the same condition in RLS via
  // is_own_active_membership() so the database agrees with the page.
  //
  // Multiple memberships are expected: a practitioner working at two practices
  // has two rows, and the bills shown are theirs wherever they were raised.
  const { data: myMemberships } = await supabase
    .from('practice_members')
    .select('id')
    .eq('user_id', user.id)
    .eq('active', true);

  const myActiveMemberIds = (myMemberships ?? []).map((m) => m.id as string);
  if (myActiveMemberIds.length === 0) redirect('/login?reason=membership_inactive');

  const [
    { data: plans },
    { count: totalBilled },
  ] = await Promise.all([
    supabase
      .from('plans')
      .select('id, total_amount, status, created_at, invoice_number, practice_reference, profiles!plans_patient_id_fkey(first_name, last_name)')
      .in('provider_member_id', myActiveMemberIds)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('plans')
      .select('*', { count: 'exact', head: true })
      .in('provider_member_id', myActiveMemberIds),
  ]);

  const rows = (plans ?? []) as unknown as ProviderPlan[];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">My Bills</h1>
        <p className="mt-1 text-sm text-gray-500">Plans assigned to you by your practice.</p>
      </div>

      {/* One count, no money aggregates.
          "Paid to your practice" and "Owed to your practice" used to sit here.
          Both are gone: a per-provider payout figure describes something that
          does not exist, because the practice is paid regardless of who
          treated the patient. Relabelling them (which is what happened last
          time) still left a doctor reading a money total keyed to their own
          name and reasonably concluding it was theirs. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total bills</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-gray-900">{totalBilled ?? 0}</p>
        </div>
      </div>
      <p className="-mt-4 text-xs text-gray-500" data-testid="provider-payout-recipient-note">
        BetterNow pays your practice directly for the plans you raise. Your practice
        handles what it pays its practitioners, so no payout figures appear here.
      </p>

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
                  {/* No "Payout" column. Its per-row Paid/Pending value was a
                      payout status keyed to this provider, which is exactly
                      the money view a provider's surface must not carry. */}
                  {['Reference', 'Patient', 'Amount', 'Status', 'Date'].map(h => (
                    <th key={h} className="px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(plan => (
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
                    <td className="px-6 py-4 text-gray-400 whitespace-nowrap text-xs">{formatDate(plan.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
