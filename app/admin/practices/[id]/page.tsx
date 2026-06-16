import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { approvePractice, suspendPractice } from '../actions';
import PracticeStatusActions from './PracticeStatusActions';
import { formatRand, formatDateStr } from '../../_lib/format';
import CollectionStatusBadge, { classifyCollection } from '../../_components/CollectionStatusBadge';
import {
  computeReliability,
  formatPercent,
  type PlanRow as ReliPlan,
  type PaymentRow as ReliPayment,
} from '../../customers/_lib/reliability';
import {
  computeStanding,
  verdictFor,
  STANDING_DISPLAY,
} from '../../_lib/standing';
import {
  sumPayouts,
  type PayoutRow as PayoutAggRow,
} from '../_lib/practiceBook';
import AdminNotes from '../../_components/AdminNotes';
import { changePracticeFeePercent } from '../../_lib/auditActions';
import FeeEditButton from './FeeEditButton';

// ─── Practice detail view ────────────────────────────────────────────────────
//
// Full read-only view of one practice plus the Approve / Suspend /
// Reactivate actions. Server-side admin authorization is asserted FIRST
// — a non-admin who types this URL directly gets bounced to the
// role-appropriate landing page, never sees the data, and never gets
// a chance to fire the actions. The admin layout also runs this check
// (belt-and-braces); both have to pass.
//
// Banking digits are masked to last-4 to keep the operator console safe
// to share-screen. Full unmasked numbers stay only in the database.

type Params = { id: string };

type PracticeFull = {
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
  account_holder:                string | null;
  account_type:                  string | null;
  fee_percent:                   number;
  owner_id:                      string;
  created_at:                    string;
  approved_at:                   string | null;
  approved_by:                   string | null;
};

type MemberFull = {
  id:                       string;
  user_id:                  string;
  role:                     string;
  active:                   boolean;
  can_create_bills:         boolean;
  can_manage_practice:      boolean;
  specialty:                string | null;
  hpcsa_number:             string | null;
  payout_destination:       string | null;
  profile: { first_name: string; last_name: string; email: string } | null;
};

function maskAccount(num: string | null): string {
  if (!num) return '—';
  if (num.length <= 4) return `…${num}`;
  return `…${num.slice(-4)}`;
}

function fullAddress(p: PracticeFull): string {
  const parts = [
    p.address_line1, p.address_line2, p.suburb, p.city,
    p.practice_province, p.postal_code,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : '—';
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending:   'bg-amber-100 text-amber-800 border-amber-200',
    approved:  'bg-green-100 text-green-700 border-green-200',
    suspended: 'bg-red-100  text-red-700   border-red-200',
    inactive:  'bg-gray-100 text-gray-600  border-gray-200',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${map[status] ?? 'bg-gray-100 text-gray-600 border-gray-200'}`}>
      {status}
    </span>
  );
}

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-gray-400 uppercase tracking-wide">{label}</p>
      <p className={`mt-0.5 text-sm text-gray-800 ${mono ? 'font-mono' : ''}`}>
        {value ?? '—'}
      </p>
    </div>
  );
}

export default async function PracticeDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { id } = await params;
  const { user, supabase } = await requireConfirmedUser({ next: `/admin/practices/${id}` });

  // Server-side admin authorization — non-admin callers bounce to the
  // role-appropriate landing page. This is enforced both here and in
  // the parent layout; either alone would suffice but both is fine.
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                              redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                               redirect('/provider');
    else                                                                          redirect('/login');
  }

  // ── Practice row ────────────────────────────────────────────────────────
  const { data: practiceRaw } = await supabase
    .from('practices')
    .select(`
      id, name, specialty, status,
      practice_registration_number, hpcsa_number,
      email, phone,
      address_line1, address_line2, suburb, city, practice_province, postal_code,
      bank_name, bank_account_number, branch_code, account_holder, account_type,
      fee_percent, owner_id,
      created_at, approved_at, approved_by
    `)
    .eq('id', id)
    .maybeSingle();

  if (!practiceRaw) notFound();
  const practice = practiceRaw as PracticeFull;

  // ── Members + owner profile ─────────────────────────────────────────────
  const { data: membersRaw } = await supabase
    .from('practice_members')
    .select(`
      id, user_id, role, active,
      can_create_bills, can_manage_practice,
      specialty, hpcsa_number, payout_destination,
      profile:profiles!practice_members_user_id_fkey(first_name, last_name, email)
    `)
    .eq('practice_id', id)
    .order('active',  { ascending: false })
    .order('role',    { ascending: true  });

  const members = (membersRaw ?? []).map((m) => ({
    ...m,
    profile: Array.isArray(m.profile) ? m.profile[0] ?? null : m.profile,
  })) as MemberFull[];

  const { data: ownerProfile } = await supabase
    .from('profiles')
    .select('first_name, last_name, email')
    .eq('id', practice.owner_id)
    .maybeSingle();

  const providerCount   = members.filter(m => m.active && m.role === 'provider').length;
  const allHpcsas       = [practice.hpcsa_number, ...members.map(m => m.hpcsa_number)]
    .filter((h): h is string => !!h);
  const bankingComplete = !!(practice.bank_name && practice.bank_account_number);

  // ── Book: plans + payments + payouts ──────────────────────────────────
  // All three queries are scoped to this practice. Plans + payments
  // drive the reliability/book-health calc (reusing the Customer 360
  // lib so the metric definitions don't drift). Payouts drive the
  // BetterNow MDR revenue and pending-out / paid-out totals.
  type PlanWithPatient = ReliPlan & {
    id: string;
    plan_type: number | null;
    created_at: string;
    completed_at: string | null;
    invoice_number: string | null;
    patient_id: string | null;
    profiles: { id: string; first_name: string; last_name: string; email: string }
            | { id: string; first_name: string; last_name: string; email: string }[]
            | null;
  };
  type PaymentWithPlan = ReliPayment & {
    id:           string;
    plan_id:      string;
    patient_id:   string | null;
    collected_at: string | null;
  };

  const { data: rawPlans } = await supabase
    .from('plans')
    .select(`
      id, total_amount, plan_type, status, created_at, completed_at,
      invoice_number, patient_id,
      profiles!plans_patient_id_fkey(id, first_name, last_name, email)
    `)
    .eq('practice_id', id)
    .order('created_at', { ascending: false });

  const plans = (rawPlans ?? []) as unknown as PlanWithPatient[];

  // Payments live on plans, not directly on practices — fetch by
  // plan_id IN (...). For zero plans we skip the query entirely.
  let payments: PaymentWithPlan[] = [];
  if (plans.length > 0) {
    const planIds = plans.map(p => p.id);
    const { data: rawPayments } = await supabase
      .from('payments')
      .select('id, plan_id, patient_id, instalment_number, amount, due_date, status, retry_count, collected_at')
      .in('plan_id', planIds);
    payments = (rawPayments ?? []) as unknown as PaymentWithPlan[];
  }

  const { data: rawPayouts } = await supabase
    .from('payouts')
    .select('gross_amount, fee_amount, net_amount, status')
    .eq('practice_id', id);
  const payouts = (rawPayouts ?? []) as PayoutAggRow[];

  // ── Aggregates ────────────────────────────────────────────────────────
  const today       = new Date().toISOString().slice(0, 10);
  const reliability = computeReliability(plans, payments, today);
  const standingId  = computeStanding(reliability);
  const standing    = STANDING_DISPLAY[standingId];
  const verdict     = verdictFor(standingId, reliability, {
    plansCount:     plans.length,
    practiceStatus: practice.status,
  });
  const payoutTot   = sumPayouts(payouts);

  // Dormant view: an approved practice with zero plans should not be
  // visually dominated by a wall of R0.00 tiles. We swap the tile row
  // for a clean inline summary in that case.
  const isDormant = plans.length === 0;

  // Per-patient aggregation across THIS practice's plans
  type PatientAgg = {
    id:            string;
    name:          string;
    email:         string;
    planCount:     number;
    outstanding:   number;
  };
  const patientMap = new Map<string, PatientAgg>();
  for (const plan of plans) {
    if (!plan.patient_id) continue;
    const profile = Array.isArray(plan.profiles) ? plan.profiles[0] : plan.profiles;
    if (!profile) continue;
    const existing = patientMap.get(plan.patient_id);
    if (existing) existing.planCount++;
    else {
      patientMap.set(plan.patient_id, {
        id:          plan.patient_id,
        name:        `${profile.first_name} ${profile.last_name}`,
        email:       profile.email,
        planCount:   1,
        outstanding: 0,
      });
    }
  }
  const OUTSTANDING = new Set(['scheduled', 'processing', 'failed', 'retried']);
  for (const p of payments) {
    if (!p.patient_id) continue;
    if (!OUTSTANDING.has(p.status)) continue;
    const agg = patientMap.get(p.patient_id);
    if (!agg) continue;
    agg.outstanding += Number(p.amount);
  }
  const patients = [...patientMap.values()].sort((a, b) => b.outstanding - a.outstanding);

  // Plan-level helpers for the "Plans originated" list
  const paymentsByPlan = new Map<string, PaymentWithPlan[]>();
  for (const p of payments) {
    const list = paymentsByPlan.get(p.plan_id) ?? [];
    list.push(p);
    paymentsByPlan.set(p.plan_id, list);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">

      {/* Breadcrumb / back link */}
      <div className="text-sm">
        <Link href="/admin/practices?status=pending" className="text-[#15A89E] hover:text-[#13294B]">
          ← Back to practices
        </Link>
      </div>

      {/* Heading + actions */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl sm:text-2xl font-semibold text-gray-900 break-words">
              {practice.name}
            </h1>
            <StatusPill status={practice.status} />
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {practice.specialty} · signed up {new Date(practice.created_at).toLocaleDateString()}
          </p>
        </div>
        <PracticeStatusActions
          practiceId={practice.id}
          status={practice.status}
          approvePractice={approvePractice}
          suspendPractice={suspendPractice}
        />
      </div>

      {/* Compliance / completeness chips */}
      <div className="flex flex-wrap gap-2">
        <Chip label={`${providerCount} active provider${providerCount === 1 ? '' : 's'}`} ok={providerCount > 0} />
        <Chip label="Banking" ok={bankingComplete} />
        <Chip label="PR" ok={!!practice.practice_registration_number} />
        <Chip label="HPCSA" ok={allHpcsas.length > 0} />
      </div>

      {/* ── Verdict header — lead with band + plain-language line ─────── */}
      <section className="rounded-2xl border-2 border-gray-200 bg-white p-5 space-y-4">
        {/* Heading row: label + standing chip + info tooltip */}
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-900">Book performance</h2>
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${standing.cls}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${standing.dot}`} aria-hidden />
            {standing.label}
          </span>
          <span
            title="Salary-date reliability is the share of instalments 2+ that collected first try. Bands: <70% at risk, 70–85% watch, ≥85% healthy. Any write-off or active failure forces 'At risk'."
            className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-gray-100 text-gray-500 text-[10px] font-bold cursor-help"
            aria-label="About this metric"
          >
            ?
          </span>
        </div>

        {/* Verdict */}
        <div>
          <p className={`text-base font-semibold ${
            standing.tone === 'alert' ? 'text-red-800'
            : standing.tone === 'warn'  ? 'text-amber-800'
            : standing.tone === 'good'  ? 'text-green-800'
            :                             'text-gray-800'
          }`}>
            {verdict.headline}
          </p>
          {verdict.subline && (
            <p className="mt-0.5 text-sm text-gray-600">{verdict.subline}</p>
          )}
        </div>

        {/* Supporting tiles — only when there's actual activity. Dormant
            practices get the verdict alone instead of a wall of R0.00s. */}
        {!isDormant && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Tile label="Financed" value={formatRand(reliability.total_financed)} />
              <Tile
                label="Collected"
                value={formatRand(reliability.total_collected)}
                tone={reliability.total_collected > 0 ? 'good' : 'default'}
              />
              <Tile
                label="Outstanding"
                value={formatRand(reliability.total_outstanding)}
                tone={reliability.outstanding_at_risk > 0 ? 'alert' : reliability.total_outstanding > 0 ? 'warn' : 'default'}
                sub={
                  reliability.total_outstanding === 0
                    ? '—'
                    : reliability.outstanding_at_risk === 0
                      ? 'all on track'
                      : reliability.outstanding_on_track === 0
                        ? `${formatRand(reliability.outstanding_at_risk)} at risk`
                        : `${formatRand(reliability.outstanding_at_risk)} at risk · ${formatRand(reliability.outstanding_on_track)} on track`
                }
              />
              <Tile
                label="On-time"
                value={formatPercent(reliability.reliability_rate)}
                tone={standing.tone === 'good' ? 'good' : standing.tone === 'alert' ? 'alert' : standing.tone === 'warn' ? 'warn' : 'default'}
                sub={
                  reliability.salary_date_due_count === 0
                    ? 'no salary-date collections yet'
                    : `${reliability.salary_date_on_time_count} of ${reliability.salary_date_due_count} salary-date, first try`
                }
              />
            </div>

            {/* Risk-count + activity strip — only when there are issues
                or non-trivial activity worth surfacing. */}
            <div className="flex gap-2 flex-wrap text-xs">
              {reliability.has_overdue && (
                <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-100 text-amber-900 px-2 py-0.5 font-medium">
                  Has overdue collection
                </span>
              )}
              {reliability.salary_date_failed_count > 0 && (
                <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 text-red-700 px-2 py-0.5 font-medium">
                  {reliability.salary_date_failed_count} failed installment{reliability.salary_date_failed_count === 1 ? '' : 's'}
                </span>
              )}
              {reliability.salary_date_written_off_count > 0 && (
                <span className="inline-flex items-center rounded-full border border-red-300 bg-red-100 text-red-900 px-2 py-0.5 font-medium">
                  {reliability.salary_date_written_off_count} written off
                </span>
              )}
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 text-gray-700 px-2 py-0.5 font-medium">
                {plans.length} {plans.length === 1 ? 'plan' : 'plans'}
              </span>
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 text-gray-700 px-2 py-0.5 font-medium">
                {patients.length} {patients.length === 1 ? 'patient' : 'patients'}
              </span>
            </div>
          </>
        )}
      </section>

      {/* Identity */}
      <Section title="Identity">
        <Grid>
          <Field label="Practice name"  value={practice.name} />
          <Field label="Specialty"      value={practice.specialty} />
          <Field label="PR (BHF)"       value={practice.practice_registration_number || '—'} mono />
          <Field label="HPCSA (practice)" value={practice.hpcsa_number || '—'} mono />
          <Field
            label="Fee %"
            value={
              <span className="inline-flex items-center gap-2">
                <span className="tabular-nums">{practice.fee_percent}%</span>
                <FeeEditButton
                  practiceId={practice.id}
                  currentFee={Number(practice.fee_percent)}
                  changeFee={changePracticeFeePercent}
                />
              </span>
            }
          />
          <Field label="Status"         value={<StatusPill status={practice.status} />} />
        </Grid>
      </Section>

      {/* Contact + address */}
      <Section title="Contact & address">
        <Grid>
          <Field label="Email" value={practice.email} />
          <Field label="Phone" value={practice.phone || '—'} mono />
          <Field label="Full address" value={fullAddress(practice)} />
        </Grid>
      </Section>

      {/* Owner */}
      <Section title="Practice owner">
        <Grid>
          <Field
            label="Name"
            value={ownerProfile ? `${ownerProfile.first_name} ${ownerProfile.last_name}` : '—'}
          />
          <Field label="Email" value={ownerProfile?.email ?? '—'} />
          <Field label="User ID" value={practice.owner_id} mono />
        </Grid>
      </Section>

      {/* ── Plans originated by this practice ─────────────────────────── */}
      <Section title={`Plans originated (${plans.length})`}>
        {plans.length === 0 ? (
          <p className="text-sm text-gray-500">No plans yet.</p>
        ) : (
          <PlansList plans={plans} paymentsByPlan={paymentsByPlan} today={today} />
        )}
      </Section>

      {/* ── Patients of this practice ──────────────────────────────────── */}
      <Section title={`Patients (${patients.length})`}>
        {patients.length === 0 ? (
          <p className="text-sm text-gray-500">No patients yet.</p>
        ) : (
          <PatientsList patients={patients} />
        )}
      </Section>

      {/* Team */}
      <Section title={`Team (${members.length})`}>
        {members.length === 0 ? (
          <p className="text-sm text-gray-500">No members yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-gray-400 uppercase tracking-wide border-b border-gray-100">
                <tr>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Role</th>
                  <th className="py-2 pr-4">Specialty</th>
                  <th className="py-2 pr-4">HPCSA</th>
                  <th className="py-2 pr-4">Capabilities</th>
                  <th className="py-2 pr-4">Active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {members.map((m) => (
                  <tr key={m.id}>
                    <td className="py-3 pr-4 text-gray-800 whitespace-nowrap">
                      {m.profile ? (
                        <>
                          <span className="font-medium">{m.profile.first_name} {m.profile.last_name}</span>
                          <br />
                          <span className="text-xs text-gray-500">{m.profile.email}</span>
                        </>
                      ) : '—'}
                    </td>
                    <td className="py-3 pr-4 text-gray-700">{m.role}</td>
                    <td className="py-3 pr-4 text-gray-700">{m.specialty || '—'}</td>
                    <td className="py-3 pr-4 text-gray-700 font-mono text-xs">{m.hpcsa_number || '—'}</td>
                    <td className="py-3 pr-4 text-xs">
                      <CapList
                        bills={m.can_create_bills}
                        manage={m.can_manage_practice}
                      />
                    </td>
                    <td className="py-3 pr-4">
                      {m.active
                        ? <span className="text-green-700 text-xs font-medium">active</span>
                        : <span className="text-gray-400 text-xs">disabled</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Banking */}
      <Section title="Banking / payout">
        <Grid>
          <Field label="Bank"            value={practice.bank_name || '—'} />
          <Field label="Account holder"  value={practice.account_holder || '—'} />
          <Field label="Account number"  value={maskAccount(practice.bank_account_number)} mono />
          <Field label="Branch code"     value={practice.branch_code || '—'} mono />
          <Field label="Account type"    value={practice.account_type || '—'} />
        </Grid>
        {!bankingComplete && (
          <p className="mt-3 text-xs text-amber-700">
            Banking is incomplete — the practice has not yet been paid out for any plan.
          </p>
        )}

        {/* Payout summary tiles */}
        <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Tile
            label="Currently owed"
            value={formatRand(payoutTot.pending_out)}
            tone={payoutTot.pending_out > 0 ? 'warn' : 'default'}
            sub={`${payoutTot.pending_count} pending payout${payoutTot.pending_count === 1 ? '' : 's'}`}
          />
          <Tile
            label="Paid out"
            value={formatRand(payoutTot.paid_out)}
            tone="good"
            sub={`${payoutTot.paid_count} settled payout${payoutTot.paid_count === 1 ? '' : 's'}`}
          />
          <Tile
            label="Fees retained"
            value={formatRand(payoutTot.fees_earned)}
            sub={`MDR @ ${practice.fee_percent}% (BetterNow revenue)`}
          />
        </div>
        <p className="mt-2 text-xs text-gray-500">
          See <Link href="/admin/payouts" className="text-[#15A89E] hover:text-[#13294B]">all payouts</Link> for
          the full ledger; this summary is scoped to this practice only.
        </p>
      </Section>

      {/* Audit */}
      <Section title="Approval audit">
        <Grid>
          <Field
            label="Signed up"
            value={new Date(practice.created_at).toLocaleString()}
          />
          <Field
            label="First approved"
            value={practice.approved_at ? new Date(practice.approved_at).toLocaleString() : 'Never'}
          />
          <Field
            label="Approved by"
            value={practice.approved_by ? `${practice.approved_by.slice(0, 8)}…` : '—'}
            mono
          />
        </Grid>
      </Section>

      {/* ── Admin notes + activity timeline ─────────────────────────── */}
      <AdminNotes entityType="practice" entityId={practice.id} />

    </div>
  );
}

// ─── Tiny presentational helpers (local to this file) ───────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-4">{children}</div>;
}

function Chip({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border',
        ok ? 'bg-green-50 text-green-700 border-green-200'
           : 'bg-amber-50 text-amber-800 border-amber-200',
      ].join(' ')}
    >
      {ok ? '✓' : '○'} {label}
    </span>
  );
}

function CapList({ bills, manage }: { bills: boolean; manage: boolean }) {
  const flags: string[] = [];
  if (bills)  flags.push('bills');
  if (manage) flags.push('manage');
  return <span className="text-gray-600">{flags.length ? flags.join(', ') : '—'}</span>;
}

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
    <div className="rounded-xl bg-white border border-gray-200 p-3">
      <p className="text-[10px] uppercase tracking-wide text-gray-500 font-medium">{label}</p>
      <p className={`mt-1 text-base font-semibold tabular-nums ${cls}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Plans list (book of this practice) ─────────────────────────────────────

type PlanLite = {
  id: string;
  total_amount: number | string;
  plan_type: number | null;
  status: string;
  created_at: string;
  invoice_number: string | null;
  patient_id: string | null;
  profiles: { id: string; first_name: string; last_name: string; email: string }
          | { id: string; first_name: string; last_name: string; email: string }[]
          | null;
};

type PaymentLite = {
  id: string;
  plan_id: string;
  instalment_number: number;
  amount: number | string;
  due_date: string;
  status: string;
  retry_count: number | null;
  collected_at: string | null;
};

const PLAN_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pending_acceptance:    { label: 'Pending acceptance',     cls: 'bg-gray-100  text-gray-700  border-gray-200'  },
  pending_first_payment: { label: 'Pending first payment',  cls: 'bg-amber-50  text-amber-800 border-amber-200' },
  active:                { label: 'Active',                 cls: 'bg-green-50  text-green-700 border-green-200' },
  completed:             { label: 'Completed',              cls: 'bg-blue-50   text-blue-700  border-blue-200'  },
  defaulted:             { label: 'Defaulted',              cls: 'bg-red-50    text-red-700   border-red-200'   },
  cancelled:             { label: 'Cancelled',              cls: 'bg-gray-100  text-gray-600  border-gray-200'  },
  declined:              { label: 'Declined',               cls: 'bg-gray-100  text-gray-600  border-gray-200'  },
};

function pickCurrentPayment(payments: PaymentLite[]): PaymentLite | null {
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

function PlansList({ plans, paymentsByPlan, today }: {
  plans: PlanLite[];
  paymentsByPlan: Map<string, PaymentLite[]>;
  today: string;
}) {
  return (
    <div className="space-y-2">
      {plans.map((plan) => {
        const profile = Array.isArray(plan.profiles) ? plan.profiles[0] : plan.profiles;
        const cfg     = PLAN_STATUS_LABEL[plan.status] ?? { label: plan.status, cls: 'bg-gray-100 text-gray-600 border-gray-200' };
        const planPayments = paymentsByPlan.get(plan.id) ?? [];
        const collected    = planPayments.filter(p => p.status === 'collected').length;
        const totalSlots   = plan.plan_type ?? (planPayments.length || null);
        const current      = pickCurrentPayment(planPayments);

        return (
          <div key={plan.id} className="rounded-xl border border-gray-200 p-3 sm:p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-gray-900 tabular-nums">
                    {formatRand(Number(plan.total_amount))}
                  </p>
                  {plan.plan_type && (
                    <span className="text-xs text-gray-500">· {plan.plan_type}-instalment</span>
                  )}
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cfg.cls}`}>
                    {cfg.label}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {profile ? (
                    <Link href={`/admin/customers/${profile.id}`} className="text-[#15A89E] hover:text-[#13294B]">
                      {profile.first_name} {profile.last_name}
                    </Link>
                  ) : '—'}
                  {plan.invoice_number && <span className="font-mono ml-2">{plan.invoice_number}</span>}
                  <span className="ml-2">· started {formatDateStr(plan.created_at.slice(0, 10))}</span>
                  <span className="ml-2">
                    · {planPayments.length === 0 ? 'no installments' : `${collected} of ${totalSlots ?? planPayments.length} collected`}
                  </span>
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

            {planPayments.length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-[#15A89E] hover:text-[#13294B] cursor-pointer select-none">
                  Show {planPayments.length} installment{planPayments.length === 1 ? '' : 's'}
                </summary>
                <div className="mt-2 space-y-1">
                  {[...planPayments].sort((a, b) => a.instalment_number - b.instalment_number).map((p) => {
                    const bucket = classifyCollection({ status: p.status, due_date: p.due_date }, today);
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

// ─── Patients list (interlink to Customer 360) ──────────────────────────────

type PatientLite = {
  id:          string;
  name:        string;
  email:       string;
  planCount:   number;
  outstanding: number;
};

function PatientsList({ patients }: { patients: PatientLite[] }) {
  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-400 uppercase tracking-wide border-b border-gray-100">
            <tr>
              <th className="py-2 pr-4">Patient</th>
              <th className="py-2 pr-4">Email</th>
              <th className="py-2 pr-4 text-right"># Plans</th>
              <th className="py-2 pr-4 text-right">Outstanding here</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {patients.map((p) => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="py-3 pr-4 whitespace-nowrap">
                  <Link href={`/admin/customers/${p.id}`} className="text-gray-900 font-medium hover:underline">
                    {p.name}
                  </Link>
                </td>
                <td className="py-3 pr-4 text-gray-600 text-xs truncate max-w-[260px]">{p.email}</td>
                <td className="py-3 pr-4 text-right tabular-nums text-gray-700">{p.planCount}</td>
                <td className="py-3 pr-4 text-right tabular-nums font-semibold text-gray-900">
                  {p.outstanding > 0 ? formatRand(p.outstanding) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden divide-y divide-gray-100">
        {patients.map((p) => (
          <Link
            key={p.id}
            href={`/admin/customers/${p.id}`}
            className="block py-3 hover:bg-gray-50 -mx-1 px-1"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">{p.name}</p>
                <p className="text-xs text-gray-500 truncate mt-0.5">{p.email}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-semibold text-gray-900 tabular-nums">
                  {p.outstanding > 0 ? formatRand(p.outstanding) : '—'}
                </p>
                <p className="text-xs text-gray-500">{p.planCount} plan{p.planCount === 1 ? '' : 's'}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
