import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { formatRand, formatDateStr, formatDateTime } from '../../_lib/format';
import CollectionStatusBadge, { classifyCollection } from '../../_components/CollectionStatusBadge';
import {
  computeReliability,
  STANDING_DISPLAY,
  formatPercent,
} from '../_lib/reliability';
import { decryptIdForDisplay } from '@/lib/idEncryption';
import { maskSaId } from '@/lib/saIdMask';

// ─── /admin/customers/[patientId] ───────────────────────────────────────────
//
// Full per-customer record. Read-heavy by design: everything an operator
// needs to understand "who is this patient, are they a risk, what do
// they owe us" without bouncing between pages. Actions stay minimal —
// retries live on the collection detail page, and other manual
// overrides (mark collected / refund / etc.) are deliberately deferred
// until the preauth-engine cut-over.
//
// All sensitive identifiers (SA ID, card last-4) are MASKED in this UI.
// SA ID rendering follows the patient profile pattern: decrypt the
// stored ciphertext, then mask the plaintext for display.

type Params = { patientId: string };

type Profile = {
  id:             string;
  first_name:     string;
  last_name:      string;
  email:          string;
  phone:          string | null;
  sa_id_number:   string | null;
  created_at:     string;
  address_line1?: string | null;
  address_line2?: string | null;
  suburb?:        string | null;
  city?:          string | null;
  province?:      string | null;
  postal_code?:   string | null;
};

type Plan = {
  id:                 string;
  total_amount:       number | string;
  plan_type:          number | null;
  status:             string;
  created_at:         string;
  completed_at:       string | null;
  invoice_number:     string | null;
  practice_id:        string;
  practices:          { id: string; name: string } | { id: string; name: string }[] | null;
};

type Payment = {
  id:                string;
  plan_id:           string;
  instalment_number: number;
  amount:            number | string;
  due_date:          string;
  status:            string;
  retry_count:       number | null;
  collected_at:      string | null;
  failure_reason:    string | null;
};

type PaymentMethod = {
  id:             string;
  card_brand:     string;
  last_four:      string;
  expiry_month:   number;
  expiry_year:    number;
  is_default:     boolean;
  reusable:       boolean | null;
  created_at:     string;
};

// Plan grouping for the detail page:
//   active   — plans currently being collected
//   history  — plans that actually RAN (completed or defaulted); these
//              tell us how the patient has behaved
//   nonstart — never ran: applied-but-not-accepted, declined, or
//              cancelled. Zero bearing on standing/reliability; shown
//              behind a collapsed disclosure so they don't compete
//              visually with real plans.
const ACTIVE_PLAN_STATUSES    = new Set(['active', 'pending_first_payment']);
const HISTORY_PLAN_STATUSES   = new Set(['completed', 'defaulted']);
const NONSTART_PLAN_STATUSES  = new Set(['pending_acceptance', 'declined', 'cancelled']);

const PLAN_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pending_acceptance:    { label: 'Pending acceptance',     cls: 'bg-gray-100  text-gray-700  border-gray-200'  },
  pending_first_payment: { label: 'Pending first payment',  cls: 'bg-amber-50  text-amber-800 border-amber-200' },
  active:                { label: 'Active',                 cls: 'bg-green-50  text-green-700 border-green-200' },
  completed:             { label: 'Completed',              cls: 'bg-blue-50   text-blue-700  border-blue-200'  },
  defaulted:             { label: 'Defaulted',              cls: 'bg-red-50    text-red-700   border-red-200'   },
  cancelled:             { label: 'Cancelled',              cls: 'bg-gray-100  text-gray-600  border-gray-200'  },
  declined:              { label: 'Declined',               cls: 'bg-gray-100  text-gray-600  border-gray-200'  },
};

function asObject<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

function Section({ title, children, subtitle }: { title: string; children: React.ReactNode; subtitle?: string }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
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

function PlanStatusBadge({ status }: { status: string }) {
  const cfg = PLAN_STATUS_LABEL[status] ?? { label: status, cls: 'bg-gray-100 text-gray-600 border-gray-200' };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

// Pick the "current" payment for a plan — the next non-terminal row in
// instalment-number order, so the admin's drill-through lands on the
// row they're most likely to be looking at. Falls back to the last
// payment if everything is terminal (completed plan).
function pickCurrentPayment(payments: Payment[]): Payment | null {
  if (payments.length === 0) return null;
  const sorted = [...payments].sort((a, b) => a.instalment_number - b.instalment_number);
  const next   = sorted.find(p =>
    p.status === 'processing' ||
    p.status === 'failed'     ||
    p.status === 'retried'    ||
    p.status === 'scheduled'
  );
  return next ?? sorted[sorted.length - 1];
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { patientId } = await params;
  const { user, supabase } = await requireConfirmedUser({
    next: `/admin/customers/${patientId}`,
  });

  // Layout-level admin auth runs first; we repeat the check here so a
  // future change that moves the route can't drop the guard. `profile`
  // is the *caller* (the admin viewing the page); the patient being
  // viewed is loaded separately into `patient` below.
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

  // ── 1. Patient profile (the customer being viewed) ──────────────────────
  const { data: patientRaw } = await supabase
    .from('profiles')
    .select(`
      id, first_name, last_name, email, phone, sa_id_number, created_at,
      address_line1, address_line2, suburb, city, province, postal_code, role
    `)
    .eq('id', patientId)
    .maybeSingle();

  if (!patientRaw) notFound();
  const patient = patientRaw as Profile & { role: string };

  // Only show patient pages for actual patients. A non-patient profile id
  // typed into the URL is a 404 (don't expose roles you shouldn't see).
  if (patient.role !== 'patient') notFound();

  // ── 2. Plans + practices for this patient ───────────────────────────────
  const { data: rawPlans } = await supabase
    .from('plans')
    .select(`
      id, total_amount, plan_type, status, created_at, completed_at,
      invoice_number, practice_id,
      practices(id, name)
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  const plans = (rawPlans ?? []) as Plan[];

  // ── 3. All payments across all plans ────────────────────────────────────
  const { data: rawPayments } = await supabase
    .from('payments')
    .select('id, plan_id, instalment_number, amount, due_date, status, retry_count, collected_at, failure_reason')
    .eq('patient_id', patientId)
    .order('due_date', { ascending: false });

  const payments = (rawPayments ?? []) as Payment[];

  // ── 4. Saved cards ──────────────────────────────────────────────────────
  const { data: rawMethods } = await supabase
    .from('payment_methods')
    .select('id, card_brand, last_four, expiry_month, expiry_year, is_default, reusable, created_at')
    .eq('patient_id', patientId)
    .order('is_default', { ascending: false })
    .order('created_at',  { ascending: false });

  const cards = (rawMethods ?? []) as PaymentMethod[];

  // ── 5. Reliability summary ──────────────────────────────────────────────
  const today  = new Date().toISOString().slice(0, 10);
  const r      = computeReliability(plans, payments, today);
  const standing = STANDING_DISPLAY[r.standing];

  // ── 6. Group plans into active / history / non-starts ──────────────────
  const activePlans   = plans.filter(p => ACTIVE_PLAN_STATUSES.has(p.status));
  const historyPlans  = plans.filter(p => HISTORY_PLAN_STATUSES.has(p.status));
  const nonStartPlans = plans.filter(p => NONSTART_PLAN_STATUSES.has(p.status));

  // ── 7. Payments grouped by plan_id for plan-level summaries ─────────────
  const paymentsByPlan = new Map<string, Payment[]>();
  for (const p of payments) {
    const list = paymentsByPlan.get(p.plan_id) ?? [];
    list.push(p);
    paymentsByPlan.set(p.plan_id, list);
  }

  // ── 8. Unique practices across all plans ────────────────────────────────
  const practicesMap = new Map<string, { id: string; name: string; planCount: number }>();
  for (const plan of plans) {
    const pr = asObject(plan.practices);
    if (!pr) continue;
    const existing = practicesMap.get(pr.id);
    if (existing) existing.planCount++;
    else practicesMap.set(pr.id, { id: pr.id, name: pr.name, planCount: 1 });
  }
  const practices = [...practicesMap.values()];

  // ── 9. Decrypt + mask SA ID (NEVER show the full plaintext) ────────────
  const saIdPlain = decryptIdForDisplay(patient.sa_id_number);
  const saIdShown = maskSaId(saIdPlain);

  const fullName = `${patient.first_name} ${patient.last_name}`.trim();

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">

      <div className="text-sm">
        <Link href="/admin/customers" className="text-[#15A89E] hover:text-[#13294B]">
          ← Back to customers
        </Link>
      </div>

      {/* ── Reliability header ─────────────────────────────────────────── */}
      <section
        className={`rounded-2xl border-2 p-5 ${standing.cls.replace(/text-\w+-800?/, '')}`}
      >
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">{fullName}</h1>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${standing.cls}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${standing.dot}`} aria-hidden />
                {standing.label}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm text-gray-700">
              <p><span className="text-gray-400 text-xs uppercase tracking-wide mr-2">Email</span>{patient.email}</p>
              <p><span className="text-gray-400 text-xs uppercase tracking-wide mr-2">Phone</span>{patient.phone ?? '—'}</p>
              <p><span className="text-gray-400 text-xs uppercase tracking-wide mr-2">SA ID</span><span className="font-mono">{saIdShown || '—'}</span></p>
              <p><span className="text-gray-400 text-xs uppercase tracking-wide mr-2">Signed up</span>{formatDateStr(patient.created_at.slice(0, 10))}</p>
            </div>
          </div>

          {/* Reliability tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 lg:max-w-xl w-full lg:w-auto">
            <Tile label="Financed"  value={formatRand(r.total_financed)} />
            <Tile label="Collected" value={formatRand(r.total_collected)} tone="good" />
            <Tile
              label="Outstanding"
              value={formatRand(r.total_outstanding)}
              tone={r.outstanding_at_risk > 0 ? 'alert' : r.total_outstanding > 0 ? 'warn' : 'default'}
              sub={
                r.total_outstanding === 0
                  ? '—'
                  : r.outstanding_at_risk === 0
                    ? 'all on track'
                    : r.outstanding_on_track === 0
                      ? `${formatRand(r.outstanding_at_risk)} at risk`
                      : `${formatRand(r.outstanding_at_risk)} at risk · ${formatRand(r.outstanding_on_track)} on track`
              }
            />
            <Tile
              label="On-time"
              value={formatPercent(r.reliability_rate)}
              sub={
                r.salary_date_due_count === 0
                  ? 'no salary-date collections yet'
                  : `${r.salary_date_on_time_count} of ${r.salary_date_due_count} salary-date, first try`
              }
            />
          </div>
        </div>

        {/* Salary-date risk count strip — visible whenever there are
            any issues. Counts exclude instalment 1 (it's charged at
            acceptance and doesn't reflect on the patient). */}
        {(r.has_overdue || r.salary_date_failed_count > 0 || r.salary_date_written_off_count > 0) && (
          <div className="mt-4 flex gap-2 flex-wrap text-xs">
            {r.has_overdue && (
              <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-100 text-amber-900 px-2 py-0.5 font-medium">
                Has overdue collection
              </span>
            )}
            {r.salary_date_failed_count > 0 && (
              <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 text-red-700 px-2 py-0.5 font-medium">
                {r.salary_date_failed_count} failed installment{r.salary_date_failed_count === 1 ? '' : 's'}
              </span>
            )}
            {r.salary_date_written_off_count > 0 && (
              <span className="inline-flex items-center rounded-full border border-red-300 bg-red-100 text-red-900 px-2 py-0.5 font-medium">
                {r.salary_date_written_off_count} written off
              </span>
            )}
          </div>
        )}
      </section>

      {/* ── Active plans ──────────────────────────────────────────────── */}
      <Section
        title="Active plans"
        subtitle={
          activePlans.length === 0
            ? 'No active plans right now.'
            : `${activePlans.length} plan${activePlans.length === 1 ? '' : 's'} currently being collected.`
        }
      >
        {activePlans.length === 0 ? (
          <p className="text-sm text-gray-500">—</p>
        ) : (
          <PlansList plans={activePlans} paymentsByPlan={paymentsByPlan} today={today} />
        )}
      </Section>

      {/* ── Plan history (plans that actually ran) ──────────────────── */}
      {historyPlans.length > 0 && (
        <Section
          title="Plan history"
          subtitle={`${historyPlans.length} completed / defaulted plan${historyPlans.length === 1 ? '' : 's'}.`}
        >
          <PlansList plans={historyPlans} paymentsByPlan={paymentsByPlan} today={today} />
        </Section>
      )}

      {/* ── Non-starts (low-prominence) ──────────────────────────────── */}
      {nonStartPlans.length > 0 && (
        <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
          <details>
            <summary className="text-sm text-gray-500 cursor-pointer select-none hover:text-gray-800">
              {nonStartPlans.length} declined / cancelled application{nonStartPlans.length === 1 ? '' : 's'}
              <span className="ml-2 text-xs text-gray-400">— never ran, zero bearing on standing</span>
            </summary>
            <ul className="mt-3 space-y-1 text-sm">
              {nonStartPlans.map((plan) => {
                const practice = asObject(plan.practices);
                const cfg      = PLAN_STATUS_LABEL[plan.status] ?? { label: plan.status, cls: 'bg-gray-100 text-gray-600 border-gray-200' };
                return (
                  <li key={plan.id} className="flex items-center justify-between gap-3 py-1">
                    <div className="min-w-0">
                      <span className="text-gray-700">{formatRand(Number(plan.total_amount))}</span>
                      {plan.invoice_number && (
                        <span className="ml-2 font-mono text-xs text-gray-500">{plan.invoice_number}</span>
                      )}
                      <span className="ml-2 text-xs text-gray-500">
                        {practice?.name ?? '—'} · {formatDateStr(plan.created_at.slice(0, 10))}
                      </span>
                    </div>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cfg.cls}`}>
                      {cfg.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </details>
        </section>
      )}

      {/* ── Payment ledger ───────────────────────────────────────────── */}
      <Section
        title="Payment history"
        subtitle={
          payments.length === 0
            ? 'No installments scheduled yet.'
            : `${payments.length} installment${payments.length === 1 ? '' : 's'} across all plans, most recent first.`
        }
      >
        {payments.length === 0 ? (
          <p className="text-sm text-gray-500">—</p>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-gray-400 uppercase tracking-wide border-b border-gray-100">
                  <tr>
                    <th className="py-2 pr-4">Due</th>
                    <th className="py-2 pr-4">Invoice</th>
                    <th className="py-2 pr-4">#</th>
                    <th className="py-2 pr-4">Amount</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Collected</th>
                    <th className="py-2 pr-4">Retry</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {payments.map((p) => {
                    const bucket = classifyCollection(p, today);
                    const plan   = plans.find(pl => pl.id === p.plan_id);
                    return (
                      <tr key={p.id} className="hover:bg-gray-50">
                        <td className="py-2 pr-4 text-gray-700 whitespace-nowrap">{formatDateStr(p.due_date)}</td>
                        <td className="py-2 pr-4 text-xs font-mono text-gray-600">
                          {plan?.invoice_number ?? '—'}
                        </td>
                        <td className="py-2 pr-4 text-gray-700 whitespace-nowrap">
                          {p.instalment_number}{plan?.plan_type ? ` of ${plan.plan_type}` : ''}
                        </td>
                        <td className="py-2 pr-4 text-gray-900 tabular-nums whitespace-nowrap">{formatRand(Number(p.amount))}</td>
                        <td className="py-2 pr-4 whitespace-nowrap">
                          <Link href={`/admin/collections/${p.id}`} className="hover:opacity-80">
                            <CollectionStatusBadge bucket={bucket} />
                          </Link>
                        </td>
                        <td className="py-2 pr-4 text-xs text-gray-500 whitespace-nowrap">
                          {p.collected_at ? formatDateTime(p.collected_at) : '—'}
                        </td>
                        <td className="py-2 pr-4 text-xs text-gray-500 tabular-nums whitespace-nowrap">
                          {p.retry_count && p.retry_count > 0 ? p.retry_count : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-gray-100">
              {payments.map((p) => {
                const bucket = classifyCollection(p, today);
                const plan   = plans.find(pl => pl.id === p.plan_id);
                return (
                  <Link
                    key={p.id}
                    href={`/admin/collections/${p.id}`}
                    className="block py-3 hover:bg-gray-50 -mx-1 px-1"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900">
                          {formatRand(Number(p.amount))}
                          <span className="ml-2 text-xs text-gray-500 font-normal">
                            {p.instalment_number}{plan?.plan_type ? ` of ${plan.plan_type}` : ''}
                          </span>
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Due {formatDateStr(p.due_date)}
                          {plan?.invoice_number && <span className="font-mono ml-2">{plan.invoice_number}</span>}
                        </p>
                      </div>
                      <CollectionStatusBadge bucket={bucket} />
                    </div>
                    {p.failure_reason && (
                      <p className="mt-1 text-xs text-red-600 truncate">{p.failure_reason}</p>
                    )}
                  </Link>
                );
              })}
            </div>
          </>
        )}
      </Section>

      {/* ── Saved cards ──────────────────────────────────────────────── */}
      <Section
        title="Saved cards"
        subtitle={
          cards.length === 0
            ? 'No saved cards. Collections cannot run until one is on file.'
            : `${cards.length} card${cards.length === 1 ? '' : 's'} on file. Default card is what collections charge against.`
        }
      >
        {cards.length === 0 ? (
          <p className="text-sm text-gray-500">—</p>
        ) : (
          <div className="space-y-2">
            {cards.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-3"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {c.card_brand} · ••••&nbsp;{c.last_four}
                    {c.is_default && (
                      <span className="ml-2 inline-flex items-center rounded-full bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                        Default
                      </span>
                    )}
                    {c.reusable === false && (
                      <span className="ml-2 inline-flex items-center rounded-full bg-gray-100 text-gray-600 border border-gray-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                        Not reusable
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Expires {String(c.expiry_month).padStart(2, '0')}/{c.expiry_year}
                    {' · added '}{formatDateStr(c.created_at.slice(0, 10))}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── Practices ────────────────────────────────────────────────── */}
      <Section
        title="Practices"
        subtitle={
          practices.length === 0
            ? 'No practices yet.'
            : `Patient has plans with ${practices.length} practice${practices.length === 1 ? '' : 's'}.`
        }
      >
        {practices.length === 0 ? (
          <p className="text-sm text-gray-500">—</p>
        ) : (
          <ul className="space-y-1">
            {practices.map((pr) => (
              <li key={pr.id}>
                <Link
                  href={`/admin/practices/${pr.id}`}
                  className="text-sm text-[#15A89E] hover:text-[#13294B]"
                >
                  {pr.name}
                </Link>
                <span className="text-xs text-gray-500 ml-2">
                  {pr.planCount} plan{pr.planCount === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── Contact / address ────────────────────────────────────────── */}
      <Section title="Contact & address">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-4">
          <Field label="Email" value={patient.email} />
          <Field label="Phone" value={patient.phone ?? '—'} />
          <Field label="Address line 1" value={patient.address_line1 ?? '—'} />
          <Field label="Address line 2" value={patient.address_line2 ?? '—'} />
          <Field label="Suburb"         value={patient.suburb        ?? '—'} />
          <Field label="City"           value={patient.city          ?? '—'} />
          <Field label="Province"       value={patient.province      ?? '—'} />
          <Field label="Postal code"    value={patient.postal_code   ?? '—'} />
        </div>
      </Section>

    </div>
  );
}

// ─── Local components ──────────────────────────────────────────────────────

function Tile({ label, value, sub, tone = 'default' }: {
  label: string;
  value: string;
  sub?:  string;
  tone?: 'default' | 'good' | 'warn' | 'alert';
}) {
  const cls =
    tone === 'good'  ? 'text-green-700'
    : tone === 'warn'  ? 'text-amber-700'
    : tone === 'alert' ? 'text-red-700'
    :                    'text-gray-900';
  return (
    <div className="rounded-xl bg-white/80 border border-white/60 p-3">
      <p className="text-[10px] uppercase tracking-wide text-gray-500 font-medium">{label}</p>
      <p className={`mt-1 text-base font-semibold tabular-nums ${cls}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function PlansList({ plans, paymentsByPlan, today }: {
  plans: Plan[];
  paymentsByPlan: Map<string, Payment[]>;
  today: string;
}) {
  return (
    <div className="space-y-3">
      {plans.map((plan) => {
        const planPayments = paymentsByPlan.get(plan.id) ?? [];
        const collected    = planPayments.filter(p => p.status === 'collected');
        const remaining    = planPayments.filter(p =>
          p.status === 'scheduled' || p.status === 'processing' || p.status === 'failed' || p.status === 'retried'
        );
        const remainingTotal = remaining.reduce((s, p) => s + Number(p.amount), 0);
        const current        = pickCurrentPayment(planPayments);
        const next           = remaining.length > 0
          ? [...remaining].sort((a, b) => a.due_date.localeCompare(b.due_date))[0]
          : null;
        const practice = asObject(plan.practices);

        return (
          <div key={plan.id} className="rounded-xl border border-gray-200 p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-gray-900">
                    {formatRand(Number(plan.total_amount))}
                    {plan.plan_type && <span className="text-xs text-gray-500 font-normal ml-1">· {plan.plan_type}-instalment</span>}
                  </p>
                  <PlanStatusBadge status={plan.status} />
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {practice?.name ?? '—'}
                  {plan.invoice_number && <span className="font-mono ml-2">{plan.invoice_number}</span>}
                  <span className="ml-2">· started {formatDateStr(plan.created_at.slice(0, 10))}</span>
                </p>
              </div>
              {current && (
                <Link
                  href={`/admin/collections/${current.id}`}
                  className="text-xs font-medium text-[#15A89E] hover:text-[#13294B] whitespace-nowrap"
                >
                  Open current installment →
                </Link>
              )}
            </div>

            <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-xs">
              <div>
                <p className="text-gray-400 uppercase tracking-wide text-[10px]">Progress</p>
                <p className="text-gray-800">
                  {/* A plan with no installment rows shows a clean "No installments"
                      — never a literal "?" placeholder. plan_type is the trusted
                      total when present (2 or 3); otherwise fall back to the
                      payment-row count. */}
                  {planPayments.length === 0
                    ? 'No installments'
                    : `${collected.length} of ${plan.plan_type ?? planPayments.length} collected`}
                </p>
              </div>
              <div>
                <p className="text-gray-400 uppercase tracking-wide text-[10px]">Remaining</p>
                <p className="text-gray-800 tabular-nums">
                  {remainingTotal > 0 ? formatRand(remainingTotal) : '—'}
                </p>
              </div>
              <div>
                <p className="text-gray-400 uppercase tracking-wide text-[10px]">Next due</p>
                <p className="text-gray-800">
                  {next ? formatDateStr(next.due_date) : '—'}
                </p>
              </div>
            </div>

            {/* Inline installments — collapsed by default if many */}
            {planPayments.length > 0 && (
              <details className="mt-3">
                <summary className="text-xs text-[#15A89E] hover:text-[#13294B] cursor-pointer select-none">
                  Show {planPayments.length} installment{planPayments.length === 1 ? '' : 's'}
                </summary>
                <div className="mt-2 space-y-1">
                  {[...planPayments].sort((a, b) => a.instalment_number - b.instalment_number).map((p) => {
                    const bucket = classifyCollection(p, today);
                    return (
                      <div key={p.id} className="flex items-center justify-between gap-3 text-xs py-1">
                        <Link
                          href={`/admin/collections/${p.id}`}
                          className="text-gray-700 hover:text-[#15A89E]"
                        >
                          #{p.instalment_number} · {formatDateStr(p.due_date)} · {formatRand(Number(p.amount))}
                        </Link>
                        <CollectionStatusBadge bucket={bucket} />
                      </div>
                    );
                  })}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
