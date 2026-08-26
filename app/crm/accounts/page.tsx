import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { formatRand } from '@/app/admin/_lib/format';
import { computeAccountRows, type AccountLead, type AccountPractice, type AccountPlan, type AccountPayment } from '@/lib/crm/accounts';

// ─── /crm/accounts — converted practices, actual vs. estimated ────────
//
// Read-only. All data comes from crm_accounts_billing_summary(), a
// SECURITY DEFINER RPC that re-implements admin-sees-all /
// sales-sees-own-leads itself (see 0114) so a sales user can see
// billing for practices they converted, without granting them any
// broader access to practices/plans/payments. This page performs zero
// writes — it's a straight SELECT (via the RPC) into a pure formatter.

type SummaryRow = {
  lead_id: string;
  practice_id: string;
  practice_name: string;
  plan_id: string | null;
  payment_amount: number | null;
  payment_status: string | null;
  payment_collected_at: string | null;
};

export default async function AccountsPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/crm/accounts' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'sales' && profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  const { data: leadNames } = await supabase
    .from('crm_leads')
    .select('id, practice_name, estimated_monthly_billings, converted_practice_id')
    .not('converted_practice_id', 'is', null)
    .is('archived_at', null);

  const { data: summaryRows } = await supabase.rpc('crm_accounts_billing_summary');
  const rows = (summaryRows ?? []) as SummaryRow[];

  // Reshape the flattened RPC rows into the four collections the pure
  // aggregator expects (dedup by id, since one row per payment repeats
  // the lead/practice).
  const leads: AccountLead[] = (leadNames ?? []) as AccountLead[];
  const practiceById = new Map<string, AccountPractice>();
  const planById = new Map<string, AccountPlan>();
  const payments: AccountPayment[] = [];
  for (const r of rows) {
    if (!practiceById.has(r.practice_id)) {
      practiceById.set(r.practice_id, { id: r.practice_id, name: r.practice_name, status: null, approved_at: null });
    }
    if (r.plan_id && !planById.has(r.plan_id)) {
      planById.set(r.plan_id, { id: r.plan_id, practice_id: r.practice_id });
    }
    if (r.plan_id && r.payment_status) {
      payments.push({
        plan_id: r.plan_id,
        amount: r.payment_amount ?? 0,
        status: r.payment_status,
        collected_at: r.payment_collected_at,
      });
    }
  }

  const accountRows = computeAccountRows(
    leads,
    Array.from(practiceById.values()),
    Array.from(planById.values()),
    payments,
    new Date(),
  );
  accountRows.sort((a, b) => a.practiceName.localeCompare(b.practiceName));

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Accounts</h1>
        <p className="mt-1 text-sm text-gray-500">
          Converted practices — actual billings (trailing 30 days) vs. the estimate at signing. Read-only.
        </p>
      </div>

      {accountRows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
          <p className="text-gray-500">No converted accounts yet.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Practice', 'Estimate', 'Actual (30d)', 'Last bill', 'Status'].map(h => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {accountRows.map(r => (
                  <tr key={r.leadId} className="hover:bg-gray-50" data-testid={`account-row:${r.leadId}`}>
                    <td className="px-4 py-3 font-medium text-gray-900">{r.practiceName}</td>
                    <td className="px-4 py-3 text-xs text-gray-600 tabular-nums">
                      {r.estimate != null ? formatRand(r.estimate) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600 tabular-nums">{formatRand(r.actual30d)}</td>
                    <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                      {r.daysSinceLastBill != null ? `${r.daysSinceLastBill}d ago` : 'Never'}
                    </td>
                    <td className="px-4 py-3">
                      {r.needsAttention ? (
                        <span
                          className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 text-amber-800 px-2 py-0.5 text-xs font-medium"
                          data-testid={`account-attention:${r.leadId}`}
                        >
                          No bill in 30 days
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-green-200 bg-green-50 text-green-800 px-2 py-0.5 text-xs font-medium">
                          On track
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
