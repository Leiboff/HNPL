import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { formatRand, formatDateStr, formatDateTime, fullName, practiceName } from '../../_lib/format';
import CollectionStatusBadge, { classifyCollection } from '../../_components/CollectionStatusBadge';
import { isPatientFrozen } from '@/lib/patient/freeze';
import { retryCollection } from '../actions';
import RetryButton from './RetryButton';

// ─── /admin/collections/[paymentId] ─────────────────────────────────────────
//
// Full read view of one installment with parent plan context (all
// sibling installments + statuses) so the admin sees collection
// progress for the whole plan from one screen. Server-side admin
// authorization runs first; the layout also does, so this is
// belt-and-braces.

type Params = { paymentId: string };

type PaymentFull = {
  id:                string;
  plan_id:           string;
  patient_id:        string | null;
  instalment_number: number;
  amount:            number;
  due_date:          string;
  status:            string;
  retry_count:       number;
  collected_at:      string | null;
  failure_reason:    string | null;
  peach_payment_id:  string | null;
  created_at:        string;
  dunning_fees_cents: number | null;
  next_attempt_date:  string | null;
};

type SiblingPayment = {
  id:                string;
  instalment_number: number;
  amount:            number;
  due_date:          string;
  status:            string;
  collected_at:      string | null;
  retry_count:       number;
};

type PlanFull = {
  id:                 string;
  total_amount:       number;
  plan_type:          number | null;
  status:             string;
  invoice_number:     string | null;
  practice_reference: string | null;
  practices:          { id: string; name: string } | { id: string; name: string }[] | null;
  profiles:           { id: string; first_name: string; last_name: string; email: string } | { id: string; first_name: string; last_name: string; email: string }[] | null;
};

type PaymentMethod = {
  card_brand: string;
  last_four:  string;
};

function asObject<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-gray-400 uppercase tracking-wide">{label}</p>
      <p className={`mt-0.5 text-sm text-gray-800 ${mono ? 'font-mono break-all' : ''}`}>{value ?? '—'}</p>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-4">{children}</div>;
}

export default async function CollectionDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { paymentId } = await params;
  const { user, supabase } = await requireConfirmedUser({
    next: `/admin/collections/${paymentId}`,
  });

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

  // ── 1. The installment itself ────────────────────────────────────────
  const { data: paymentRaw } = await supabase
    .from('payments')
    .select(`
      id, plan_id, patient_id, instalment_number, amount, due_date,
      status, retry_count, collected_at, failure_reason, peach_payment_id, created_at,
      dunning_fees_cents, next_attempt_date
    `)
    .eq('id', paymentId)
    .maybeSingle();

  if (!paymentRaw) notFound();
  const payment = paymentRaw as PaymentFull;

  // ── 2. Plan + practice + patient ────────────────────────────────────
  const { data: planRaw } = await supabase
    .from('plans')
    .select(`
      id, total_amount, plan_type, status, invoice_number, practice_reference,
      practices(id, name),
      profiles!plans_patient_id_fkey(id, first_name, last_name, email)
    `)
    .eq('id', payment.plan_id)
    .maybeSingle();

  const plan      = planRaw as PlanFull | null;
  const practiceObj = asObject(plan?.practices);
  const patientObj  = asObject(plan?.profiles);

  // ── 3. Sibling installments on the same plan (full collection progress) ──
  const { data: siblingsRaw } = await supabase
    .from('payments')
    .select('id, instalment_number, amount, due_date, status, collected_at, retry_count')
    .eq('plan_id', payment.plan_id)
    .order('instalment_number', { ascending: true });

  const siblings = (siblingsRaw ?? []) as SiblingPayment[];

  // ── 4. Patient's default card (the one collection runs against) ─────
  let paymentMethod: PaymentMethod | null = null;
  if (payment.patient_id) {
    const { data: pmRaw } = await supabase
      .from('payment_methods')
      .select('card_brand, last_four, is_default')
      .eq('patient_id', payment.patient_id)
      .eq('is_default', true)
      .maybeSingle();
    if (pmRaw) paymentMethod = pmRaw as PaymentMethod;
  }

  // Frozen flag — the patient is blocked from new plans while ANY of
  // their instalments is defaulted (lib/patient/freeze.ts).
  const isFrozen = payment.patient_id
    ? await isPatientFrozen(supabase, payment.patient_id)
    : false;

  const today  = new Date().toISOString().slice(0, 10);
  const bucket = classifyCollection(payment, today);

  // Retry is only meaningful when the row is currently retryable —
  // scheduled-past-due or failed under the cap.
  const retryable = bucket === 'overdue' || bucket === 'failed';

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">

      <div className="text-sm">
        <Link href="/admin/collections?chip=overdue" className="text-[#15A89E] hover:text-[#13294B]">
          ← Back to collections
        </Link>
      </div>

      {/* Heading */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">
              Installment {payment.instalment_number}
              {plan?.plan_type ? ` of ${plan.plan_type}` : ''}
            </h1>
            <CollectionStatusBadge bucket={bucket} />
            {isFrozen && (
              <span className="inline-flex items-center rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                Patient frozen — blocked from new plans
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {practiceName(plan?.practices)} · {fullName(plan?.profiles ?? null)}
            {plan?.invoice_number ? ` · ${plan.invoice_number}` : ''}
          </p>
        </div>
        {retryable && (
          <RetryButton paymentId={payment.id} action={retryCollection} />
        )}
      </div>

      {/* This installment */}
      <Section title="This installment">
        <Grid>
          <Field label="Amount"        value={<span className="tabular-nums">{formatRand(Number(payment.amount))}</span>} />
          <Field label="Due date"      value={formatDateStr(payment.due_date)} />
          <Field label="Status"        value={<CollectionStatusBadge bucket={bucket} />} />
          <Field label="Retry count"   value={String(payment.retry_count)} />
          <Field
            label="Dunning fees"
            value={Number(payment.dunning_fees_cents ?? 0) > 0
              ? <span className="tabular-nums text-red-700">{formatRand(Number(payment.dunning_fees_cents) / 100)}</span>
              : '—'}
          />
          <Field label="Next retry"    value={payment.next_attempt_date ? formatDateStr(payment.next_attempt_date) : '—'} />
          <Field label="Collected at"  value={payment.collected_at ? formatDateTime(payment.collected_at) : '—'} />
          <Field label="Created at"    value={formatDateTime(payment.created_at)} />
          <Field label="Peach ref"     value={payment.peach_payment_id ?? '—'} mono />
          <Field label="Failure reason" value={payment.failure_reason ?? '—'} />
        </Grid>
      </Section>

      {/* Plan context */}
      <Section title="Plan">
        <Grid>
          <Field label="Plan total"   value={<span className="tabular-nums">{formatRand(Number(plan?.total_amount ?? 0))}</span>} />
          <Field label="Type"         value={plan?.plan_type ? `${plan.plan_type}-instalment plan` : '—'} />
          <Field label="Plan status"  value={plan?.status ?? '—'} />
          <Field label="Invoice"      value={plan?.invoice_number ?? '—'} mono />
          <Field label="Practice ref" value={plan?.practice_reference ?? '—'} />
          <Field label="Practice"     value={practiceObj?.name ?? '—'} />
        </Grid>

        {/* Sibling installments */}
        <div className="mt-5">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Collection progress</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-gray-400 uppercase tracking-wide border-b border-gray-100">
                <tr>
                  <th className="py-2 pr-4">#</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Due</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Retry</th>
                  <th className="py-2 pr-4">Collected at</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {siblings.map((s) => {
                  const sBucket = classifyCollection(s, today);
                  const isCurrent = s.id === payment.id;
                  return (
                    <tr key={s.id} className={isCurrent ? 'bg-[#15A89E]/5' : ''}>
                      <td className="py-2 pr-4 text-gray-800">
                        {isCurrent ? <strong>{s.instalment_number}</strong> : (
                          <Link href={`/admin/collections/${s.id}`} className="text-[#15A89E] hover:text-[#13294B]">
                            {s.instalment_number}
                          </Link>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-gray-800 tabular-nums">{formatRand(Number(s.amount))}</td>
                      <td className="py-2 pr-4 text-gray-700">{formatDateStr(s.due_date)}</td>
                      <td className="py-2 pr-4"><CollectionStatusBadge bucket={sBucket} /></td>
                      <td className="py-2 pr-4 text-xs text-gray-500 tabular-nums">{s.retry_count || '—'}</td>
                      <td className="py-2 pr-4 text-xs text-gray-500">{s.collected_at ? formatDateTime(s.collected_at) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      {/* Patient + card */}
      <Section title="Patient & card">
        <Grid>
          <Field label="Patient" value={patientObj ? `${patientObj.first_name} ${patientObj.last_name}` : '—'} />
          <Field label="Email"   value={patientObj?.email ?? '—'} />
          <Field
            label="Default card"
            value={paymentMethod ? `${paymentMethod.card_brand} · …${paymentMethod.last_four}` : 'No default card on file'}
          />
        </Grid>
      </Section>

    </div>
  );
}
