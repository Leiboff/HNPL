import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { ActionButton } from '../OpsActions';
import { formatRand, formatDateTime, fullName, practiceName } from '../_lib/format';
import { sastDateString } from '@/lib/payments/payoutWindow';
import { markPayoutPaid, markBatchPaid } from './actions';

// ─── /admin/payouts ─────────────────────────────────────────────────────────
//
// All payouts owed to practices: pending (HNPL owes the practice) and
// paid (settled). "Mark paid" is a bookkeeping flip — the actual payout
// happens via banking/EFT outside the app.
//
// BATCH-FIRST since migration 0090. A practice reconciles ONE weekly bank
// deposit against ONE batch, so the batch is the unit an admin settles —
// flipping half a batch's plans would leave the practice with a figure they
// can't check against their statement.
//
// Three sections, in the order an operator works:
//   1. Weekly batches      — the settle surface. One row per practice per
//                            week, with the exact window it covers.
//   2. Not yet batched     — pending payouts activated since the last Friday
//                            run. They join next Friday's batch. Individually
//                            settleable, for legacy rows and one-offs.
//   3. Settled payouts     — history, unchanged.
//
// Payouts that ARE in a batch deliberately have no per-row action here; the
// server action refuses them too (see ./actions.ts).

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
  batch_id:     string | null;
  practices:    PracticeRef | PracticeRef[] | null;
  plans:        PlanProfileRef | PlanProfileRef[] | null;
};

type BatchRow = {
  id:           string;
  practice_id:  string;
  window_start: string;
  window_end:   string;
  total_net:    number;
  plan_count:   number;
  status:       string;
  run_at:       string;
  paid_at:      string | null;
  practices:    PracticeRef | PracticeRef[] | null;
};

/**
 * The window a practice reconciles against, in SAST calendar dates with an
 * INCLUSIVE end. window_end is stored exclusive (Thursday 00:00 SAST), so the
 * last covered day is the day before it — never show the exclusive Thursday
 * to a human, it reads as an extra day of cover.
 */
function windowLabel(b: BatchRow): string {
  const lastDay = new Date(new Date(b.window_end).getTime() - 24 * 60 * 60 * 1000);
  return `${sastDateString(new Date(b.window_start))} → ${sastDateString(lastDay)}`;
}

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

  const [{ data: rawPayouts }, { data: rawBatches }] = await Promise.all([
    supabase
      .from('payouts')
      .select(`
        id, gross_amount, fee_amount, net_amount, status, created_at, batch_id,
        practices(name),
        plans(invoice_number, profiles!plans_patient_id_fkey(first_name, last_name))
      `)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('payout_batches')
      .select(`
        id, practice_id, window_start, window_end, total_net, plan_count,
        status, run_at, paid_at,
        practices(name)
      `)
      .order('window_start', { ascending: false })
      .limit(200),
  ]);

  const payouts = (rawPayouts ?? []) as unknown as PayoutRow[];
  const batches = (rawBatches ?? []) as unknown as BatchRow[];

  const pendingBatches = batches.filter(b => b.status === 'pending');
  const paidBatches    = batches.filter(b => b.status !== 'pending');

  // Pending AND unbatched — the only per-payout rows an admin can settle
  // individually. Batched-pending rows are settled through their batch.
  const unbatched = payouts.filter(p => p.status === 'pending' && !p.batch_id);
  const settled   = payouts.filter(p => p.status !== 'pending');

  const totalBatchedPending = pendingBatches.reduce((s, b) => s + Number(b.total_net), 0);
  const totalUnbatched      = unbatched.reduce((s, p) => s + Number(p.net_amount), 0);
  const totalSettled        = settled.reduce((s, p) => s + Number(p.net_amount), 0);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">

      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Payouts</h1>
        <p className="mt-1 text-sm text-gray-500">
          Money HNPL owes practices. Batched every Friday, covering plans activated
          Thursday to Wednesday (SAST) — one batch is one bank deposit.
          The transfer is made via banking outside the app; &ldquo;Mark paid&rdquo; is the bookkeeping flip.
        </p>
      </div>

      {/* Summary chips */}
      <div className="flex gap-3 flex-wrap text-sm">
        <div className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5">
          <span className="text-amber-800 font-medium">Awaiting transfer: </span>
          <span className="tabular-nums text-amber-900 font-semibold" data-testid="batched-pending-total">
            {formatRand(totalBatchedPending)}
          </span>
          <span className="ml-2 text-amber-700">({pendingBatches.length} batches)</span>
        </div>
        <div className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5">
          <span className="text-gray-700 font-medium">Not yet batched: </span>
          <span className="tabular-nums text-gray-900 font-semibold">{formatRand(totalUnbatched)}</span>
          <span className="ml-2 text-gray-600">({unbatched.length})</span>
        </div>
        <div className="rounded-full border border-green-200 bg-green-50 px-3 py-1.5">
          <span className="text-green-800 font-medium">Settled: </span>
          <span className="tabular-nums text-green-900 font-semibold">{formatRand(totalSettled)}</span>
          <span className="ml-2 text-green-700">({settled.length})</span>
        </div>
      </div>

      {/* Weekly batches — the settle surface */}
      <section className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-4 sm:px-5 py-3 bg-gray-50 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900">Weekly batches — awaiting transfer</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            One deposit per practice per week. Settle the whole batch so the practice can
            reconcile it against their statement.
          </p>
        </div>
        {pendingBatches.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500" data-testid="no-pending-batches">
            No batches awaiting transfer.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white border-b border-gray-100">
                <tr>
                  {['Practice', 'Covers (SAST)', 'Plans', 'Net to pay', 'Batched', 'Action'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100" data-testid="pending-batches">
                {pendingBatches.map((b) => (
                  <tr key={b.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900 whitespace-nowrap">{practiceName(b.practices)}</td>
                    <td className="px-4 py-3 text-gray-700 font-mono text-xs whitespace-nowrap">{windowLabel(b)}</td>
                    <td className="px-4 py-3 text-gray-700 tabular-nums whitespace-nowrap">{b.plan_count}</td>
                    <td className="px-4 py-3 text-gray-900 tabular-nums whitespace-nowrap font-semibold">
                      {formatRand(Number(b.total_net))}
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDateTime(b.run_at)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <ActionButton
                        id={b.id}
                        label="Mark batch paid"
                        loadingLabel="Marking…"
                        action={markBatchPaid}
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

      {/* Paid batches — reconciliation history */}
      {paidBatches.length > 0 && (
        <section className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="px-4 sm:px-5 py-3 bg-gray-50 border-b border-gray-200">
            <h2 className="text-sm font-semibold text-gray-900">Paid batches</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white border-b border-gray-100">
                <tr>
                  {['Practice', 'Covers (SAST)', 'Plans', 'Net paid', 'Paid at'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100" data-testid="paid-batches">
                {paidBatches.map((b) => (
                  <tr key={b.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900 whitespace-nowrap">{practiceName(b.practices)}</td>
                    <td className="px-4 py-3 text-gray-700 font-mono text-xs whitespace-nowrap">{windowLabel(b)}</td>
                    <td className="px-4 py-3 text-gray-700 tabular-nums whitespace-nowrap">{b.plan_count}</td>
                    <td className="px-4 py-3 text-gray-900 tabular-nums whitespace-nowrap font-semibold">
                      {formatRand(Number(b.total_net))}
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                      {b.paid_at ? formatDateTime(b.paid_at) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Not yet batched */}
      <section className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-4 sm:px-5 py-3 bg-gray-50 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900">Not yet batched</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Activated since the last Friday run — these join the next batch. Settle
            individually only for legacy or one-off cases.
          </p>
        </div>
        {unbatched.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">Nothing waiting to be batched.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white border-b border-gray-100">
                <tr>
                  {['Practice', 'Patient', 'Invoice', 'Gross', 'Fee', 'Net', 'Activated', 'Action'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100" data-testid="unbatched-payouts">
                {unbatched.map((p) => (
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
