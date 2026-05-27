import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import LogoutButton from '@/app/dashboard/LogoutButton';
import { ActionButton, CollectionActions, FirstPaymentActions } from './OpsActions';
import { calculateFee } from '@/lib/finance';
import { paystackRequest } from '@/lib/paystack';

// ─── Types ────────────────────────────────────────────────────────────────────

type NameRef         = { first_name: string; last_name: string };
type PracticeRef     = { name: string };
type PracticeWithFee = { name: string; fee_percent: number };
type PlanRef         = { plan_type: number | null; status: string; practices: PracticeRef | PracticeRef[] | null };
type PlanProfileRef  = { invoice_number: string | null; profiles: NameRef | NameRef[] | null };

type PendingFirstPaymentPlan = {
  id: string;
  total_amount: number;
  invoice_number: string | null;
  profiles: NameRef | NameRef[] | null;
  practices: PracticeWithFee | PracticeWithFee[] | null;
};

type UpcomingPayment = {
  id: string;
  instalment_number: number;
  amount: number;
  due_date: string;
  profiles: NameRef | NameRef[] | null;
  plans: PlanRef | PlanRef[] | null;
};

type PlanOverview = {
  id: string;
  total_amount: number;
  plan_type: number | null;
  status: string;
  created_at: string;
  invoice_number: string | null;
  practice_reference: string | null;
  profiles: NameRef | NameRef[] | null;
  practices: PracticeRef | PracticeRef[] | null;
  payments: { status: string }[];
};

type PayoutRow = {
  id: string;
  gross_amount: number;
  fee_amount: number;
  net_amount: number;
  status: string;
  created_at: string;
  practices: PracticeRef | PracticeRef[] | null;
  plans: PlanProfileRef | PlanProfileRef[] | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

function formatDateStr(s: string): string {
  const [year, month, day] = s.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function fullName(p: NameRef | NameRef[] | null): string {
  const ref = Array.isArray(p) ? p[0] : p;
  if (!ref) return '—';
  return `${ref.first_name} ${ref.last_name}`;
}

function practiceName(p: PracticeRef | PracticeRef[] | null): string {
  const ref = Array.isArray(p) ? p[0] : p;
  return ref?.name ?? '—';
}

function instalmentLabel(payment: UpcomingPayment): string {
  const plan = Array.isArray(payment.plans) ? payment.plans[0] : payment.plans;
  if (!plan?.plan_type) return `#${payment.instalment_number}`;
  return `${payment.instalment_number} of ${plan.plan_type}`;
}

function planProgress(plan: PlanOverview): string {
  if (plan.plan_type == null) return '—';
  const done = plan.payments.filter((p) => p.status === 'collected').length;
  return `${done} / ${plan.plan_type} collected`;
}

// ─── Server Actions ───────────────────────────────────────────────────────────

async function verifyAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase: null, error: 'Not authenticated.' } as const;
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (p?.role !== 'admin') return { supabase: null, error: 'Unauthorized.' } as const;
  return { supabase, error: null } as const;
}

async function confirmFirstPayment(planId: string): Promise<{ error: string | null }> {
  'use server';
  const { supabase, error: authError } = await verifyAdmin();
  if (authError) return { error: authError };

  const { data: plan } = await supabase!
    .from('plans')
    .select('id, total_amount, practice_id, status')
    .eq('id', planId)
    .eq('status', 'pending_first_payment')
    .maybeSingle();
  if (!plan) return { error: 'Plan not found or not pending first payment.' };

  const now = new Date().toISOString();

  const { error: pe } = await supabase!
    .from('payments')
    .update({ status: 'collected', collected_at: now })
    .eq('plan_id', planId)
    .eq('instalment_number', 1);
  if (pe) return { error: pe.message };

  const { error: ple } = await supabase!
    .from('plans')
    .update({ status: 'active' })
    .eq('id', planId);
  if (ple) return { error: ple.message };

  const { data: practice } = await supabase!
    .from('practices')
    .select('fee_percent')
    .eq('id', plan.practice_id as string)
    .single();
  const feePercent = Number(practice?.fee_percent ?? 6);
  const { gross, fee, net } = calculateFee(Number(plan.total_amount), feePercent);

  const { error: poe } = await supabase!
    .from('payouts')
    .insert({
      id: crypto.randomUUID(),
      practice_id: plan.practice_id as string,
      plan_id: planId,
      gross_amount: gross,
      fee_amount: fee,
      net_amount: net,
      status: 'pending',
    });
  if (poe) return { error: poe.message };

  revalidatePath('/admin');
  return { error: null };
}

async function failFirstPayment(planId: string): Promise<{ error: string | null }> {
  'use server';
  const { supabase, error: authError } = await verifyAdmin();
  if (authError) return { error: authError };

  const { data: plan } = await supabase!
    .from('plans')
    .select('id, status')
    .eq('id', planId)
    .eq('status', 'pending_first_payment')
    .maybeSingle();
  if (!plan) return { error: 'Plan not found or not pending first payment.' };

  const { error: pe } = await supabase!
    .from('payments')
    .update({ status: 'failed', failure_reason: 'First payment failed' })
    .eq('plan_id', planId)
    .eq('instalment_number', 1);
  if (pe) return { error: pe.message };

  const { error: ple } = await supabase!
    .from('plans')
    .update({ status: 'cancelled' })
    .eq('id', planId);
  if (ple) return { error: ple.message };

  revalidatePath('/admin');
  return { error: null };
}

async function markPaymentCollected(paymentId: string): Promise<{ error: string | null }> {
  'use server';
  const { supabase, error: authError } = await verifyAdmin();
  if (authError) return { error: authError };

  const { data: payment } = await supabase!
    .from('payments')
    .select('id, plan_id, status')
    .eq('id', paymentId)
    .in('status', ['scheduled', 'failed', 'retried'])
    .maybeSingle();
  if (!payment) return { error: 'Payment not found or not in a collectable state.' };

  const now = new Date().toISOString();

  const { error: pe } = await supabase!
    .from('payments')
    .update({ status: 'collected', collected_at: now })
    .eq('id', paymentId);
  if (pe) return { error: pe.message };

  const { data: remaining } = await supabase!
    .from('payments')
    .select('id')
    .eq('plan_id', payment.plan_id as string)
    .neq('status', 'collected');
  if (!remaining || remaining.length === 0) {
    await supabase!
      .from('plans')
      .update({ status: 'completed', completed_at: now })
      .eq('id', payment.plan_id as string);
  }

  revalidatePath('/admin');
  return { error: null };
}

async function chargeInstalment(paymentId: string): Promise<{ error: string | null }> {
  'use server';
  const { supabase, error: authError } = await verifyAdmin();
  if (authError) return { error: authError };

  const { data: payment } = await supabase!
    .from('payments')
    .select('id, plan_id, patient_id, instalment_number, amount, status')
    .eq('id', paymentId)
    .in('status', ['scheduled', 'failed', 'retried'])
    .maybeSingle();

  if (!payment) return { error: 'Payment not found or not chargeable. It may already be collected or processing.' };

  const { data: plan } = await supabase!
    .from('plans')
    .select('id, paystack_authorization_code, patient_id')
    .eq('id', payment.plan_id as string)
    .maybeSingle();

  if (!plan) return { error: 'Plan not found.' };
  if (!plan.paystack_authorization_code) return { error: 'No saved card for this plan.' };

  const patientId = (plan.patient_id ?? payment.patient_id) as string;

  const { data: profile } = await supabase!
    .from('profiles')
    .select('email')
    .eq('id', patientId)
    .single();

  if (!profile?.email) return { error: 'Patient email not found.' };

  // Store the reference on the payment row BEFORE charging so the webhook can match it back
  const reference = `hnpl_${paymentId.replace(/-/g, '').slice(0, 20)}`;

  const { error: refErr } = await supabase!
    .from('payments')
    .update({ peach_payment_id: reference })
    .eq('id', paymentId);

  if (refErr) return { error: refErr.message };

  // Initiate the charge — the definitive result comes via webhook
  const amountCents = Math.round(Number(payment.amount) * 100);
  try {
    await paystackRequest('/transaction/charge_authorization', {
      method: 'POST',
      body: JSON.stringify({
        authorization_code: plan.paystack_authorization_code,
        email:              profile.email,
        amount:             amountCents,
        currency:           'ZAR',
        reference,
      }),
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Paystack charge failed.' };
  }

  // Mark as processing — webhook will flip to collected or failed
  const { error: updateErr } = await supabase!
    .from('payments')
    .update({ status: 'processing' })
    .eq('id', paymentId);

  if (updateErr) return { error: updateErr.message };

  revalidatePath('/admin');
  return { error: null };
}

async function markPayoutPaid(payoutId: string): Promise<{ error: string | null }> {
  'use server';
  const { supabase, error: authError } = await verifyAdmin();
  if (authError) return { error: authError };

  const { data: payout } = await supabase!
    .from('payouts')
    .select('id, status')
    .eq('id', payoutId)
    .eq('status', 'pending')
    .maybeSingle();
  if (!payout) return { error: 'Payout not found or not pending.' };

  const { error: pe } = await supabase!
    .from('payouts')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', payoutId);
  if (pe) return { error: pe.message };

  revalidatePath('/admin');
  return { error: null };
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  valueClass = 'text-gray-900',
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide leading-tight">
        {label}
      </p>
      <p className={`mt-2 text-lg font-semibold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  );
}

// ─── Badges ───────────────────────────────────────────────────────────────────

const PLAN_CFG: Record<string, { label: string; cls: string }> = {
  pending_acceptance:    { label: 'Awaiting',    cls: 'bg-amber-100 text-amber-800' },
  pending_first_payment: { label: 'Pending 1st', cls: 'bg-blue-100  text-blue-700'  },
  active:                { label: 'Active',      cls: 'bg-green-100 text-green-700' },
  completed:             { label: 'Completed',   cls: 'bg-gray-100  text-gray-500'  },
  defaulted:             { label: 'Defaulted',   cls: 'bg-red-100   text-red-700'   },
  declined:              { label: 'Declined',    cls: 'bg-gray-100  text-gray-400'  },
  cancelled:             { label: 'Cancelled',   cls: 'bg-gray-100  text-gray-400'  },
};

const PAYOUT_CFG: Record<string, { label: string; cls: string }> = {
  pending:    { label: 'Pending',    cls: 'bg-amber-100 text-amber-700' },
  processing: { label: 'Processing', cls: 'bg-blue-100  text-blue-700'  },
  paid:       { label: 'Paid',       cls: 'bg-green-100 text-green-700' },
  failed:     { label: 'Failed',     cls: 'bg-red-100   text-red-700'   },
};

function Badge({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

// ─── Table primitives ─────────────────────────────────────────────────────────

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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function AdminDashboardPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    if (profile?.role === 'patient') {
      redirect('/patient');
    } else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') {
      redirect('/practice');
    } else {
      redirect('/login');
    }
  }

  const todayStr = new Date().toISOString().split('T')[0];

  const [
    { count: activePlansCount },
    { data: scheduledAmt },
    { data: collectedAmt },
    { data: pendingPayoutAmt },
    { data: paidPayoutAmt },
    { data: atRiskAmt },
    { data: rawUpcoming },
    { data: rawPlans },
    { data: rawPayouts },
    { data: rawFirstPayment },
  ] = await Promise.all([
    supabase.from('plans').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('payments').select('amount').eq('status', 'scheduled'),
    supabase.from('payments').select('amount').eq('status', 'collected'),
    supabase.from('payouts').select('net_amount').eq('status', 'pending'),
    supabase.from('payouts').select('net_amount').eq('status', 'paid'),
    supabase.from('payments').select('amount').in('status', ['failed', 'written_off']),
    supabase
      .from('payments')
      .select(`
        id, instalment_number, amount, due_date,
        profiles(first_name, last_name),
        plans(plan_type, status, practices(name))
      `)
      .eq('status', 'scheduled')
      .order('due_date', { ascending: true })
      .limit(200),
    supabase
      .from('plans')
      .select(`
        id, total_amount, plan_type, status, created_at,
        invoice_number, practice_reference,
        profiles(first_name, last_name),
        practices(name),
        payments(status)
      `)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('payouts')
      .select(`
        id, gross_amount, fee_amount, net_amount, status, created_at,
        practices(name),
        plans(invoice_number, profiles(first_name, last_name))
      `)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('plans')
      .select(`
        id, total_amount, invoice_number,
        profiles(first_name, last_name),
        practices(name, fee_percent)
      `)
      .eq('status', 'pending_first_payment')
      .order('created_at', { ascending: true }),
  ]);

  // ── Aggregate stats ──

  const outstanding   = (scheduledAmt     ?? []).reduce((s, p: any) => s + Number(p.amount),     0);
  const collected     = (collectedAmt     ?? []).reduce((s, p: any) => s + Number(p.amount),     0);
  const payoutsPend   = (pendingPayoutAmt ?? []).reduce((s, p: any) => s + Number(p.net_amount), 0);
  const payoutsPaid   = (paidPayoutAmt    ?? []).reduce((s, p: any) => s + Number(p.net_amount), 0);
  const atRisk        = (atRiskAmt        ?? []).reduce((s, p: any) => s + Number(p.amount),     0);

  const firstPaymentPlans = (rawFirstPayment ?? []) as unknown as PendingFirstPaymentPlan[];
  const upcomingPayments  = ((rawUpcoming ?? []) as unknown as UpcomingPayment[]).filter((p) => {
    const plan = Array.isArray(p.plans) ? p.plans[0] : p.plans;
    return plan?.status === 'active';
  });
  const plans   = (rawPlans   ?? []) as unknown as PlanOverview[];
  const payouts = (rawPayouts ?? []) as unknown as PayoutRow[];

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="mx-auto max-w-7xl px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-base font-semibold text-gray-900">HNPL</span>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide border border-gray-200 rounded px-1.5 py-0.5">
              Ops
            </span>
          </div>
          <LogoutButton />
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8 space-y-8 pb-16">

        <div>
          <h1 className="text-xl font-semibold text-gray-900">Operations Dashboard</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Welcome, {profile?.first_name ?? user.email}
          </p>
        </div>

        {/* ── Stat cards ── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            label="Active plans"
            value={String(activePlansCount ?? 0)}
            valueClass="text-green-700"
          />
          <StatCard
            label="Outstanding to collect"
            value={formatRand(outstanding)}
            valueClass="text-amber-700"
          />
          <StatCard
            label="Collected to date"
            value={formatRand(collected)}
            valueClass="text-green-700"
          />
          <StatCard
            label="Payouts pending"
            value={formatRand(payoutsPend)}
            valueClass="text-amber-700"
          />
          <StatCard
            label="Payouts paid"
            value={formatRand(payoutsPaid)}
            valueClass="text-green-700"
          />
          <StatCard
            label="At risk"
            value={formatRand(atRisk)}
            valueClass={atRisk > 0 ? 'text-red-600' : 'text-gray-900'}
          />
        </div>

        {/* ── Awaiting first payment confirmation ── */}
        {firstPaymentPlans.length > 0 && (
          <div className="bg-white border border-blue-200 rounded-lg overflow-hidden">
            <SectionHeader title="Awaiting first payment confirmation" count={firstPaymentPlans.length} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <TH>Patient</TH>
                    <TH>Practice</TH>
                    <TH>Bill</TH>
                    <TH>Fee</TH>
                    <TH>Net payout</TH>
                    <TH>Action</TH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {firstPaymentPlans.map((plan) => {
                    const practice   = Array.isArray(plan.practices) ? plan.practices[0] : plan.practices;
                    const feePercent = Number(practice?.fee_percent ?? 6);
                    const total      = Number(plan.total_amount);
                    const { fee, net } = calculateFee(total, feePercent);
                    return (
                      <tr key={plan.id} className="hover:bg-blue-50 transition-colors">
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="block font-medium text-gray-900">{fullName(plan.profiles)}</span>
                          {plan.invoice_number && (
                            <span className="block font-mono text-xs text-gray-400 mt-0.5">{plan.invoice_number}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                          {practice?.name ?? '—'}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-gray-900 whitespace-nowrap">
                          {formatRand(total)}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-gray-500 whitespace-nowrap">
                          −{formatRand(fee)}
                        </td>
                        <td className="px-4 py-3 tabular-nums font-medium text-gray-900 whitespace-nowrap">
                          {formatRand(net)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <FirstPaymentActions
                            planId={plan.id}
                            confirmFirstPayment={confirmFirstPayment}
                            failFirstPayment={failFirstPayment}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Upcoming & overdue collections ── */}
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <SectionHeader title="Upcoming & overdue collections" count={upcomingPayments.length} />
          {upcomingPayments.length === 0 ? (
            <p className="px-5 py-8 text-sm text-gray-400">No scheduled payments.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <TH>Patient</TH>
                    <TH>Practice</TH>
                    <TH>Instalment</TH>
                    <TH>Amount</TH>
                    <TH>Due date</TH>
                    <TH>Flag</TH>
                    <TH>Action</TH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {upcomingPayments.map((payment) => {
                    const plan     = Array.isArray(payment.plans) ? payment.plans[0] : payment.plans;
                    const overdue  = payment.due_date < todayStr;
                    const dueToday = payment.due_date === todayStr;
                    return (
                      <tr
                        key={payment.id}
                        className={`hover:bg-gray-50 transition-colors ${overdue ? 'bg-red-50' : ''}`}
                      >
                        <td className="px-4 py-2.5 font-medium text-gray-900 whitespace-nowrap">
                          {fullName(payment.profiles)}
                        </td>
                        <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">
                          {practiceName(plan?.practices ?? null)}
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">
                          {instalmentLabel(payment)}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums font-medium text-gray-900 whitespace-nowrap">
                          {formatRand(Number(payment.amount))}
                        </td>
                        <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">
                          {formatDateStr(payment.due_date)}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          {overdue ? (
                            <span className="text-xs font-bold text-red-600 uppercase tracking-wide">
                              Overdue
                            </span>
                          ) : dueToday ? (
                            <span className="text-xs font-bold text-amber-600 uppercase tracking-wide">
                              Due today
                            </span>
                          ) : (
                            <span className="text-gray-300 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <CollectionActions
                            paymentId={payment.id}
                            chargeInstalment={chargeInstalment}
                            markPaymentCollected={markPaymentCollected}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Plans overview ── */}
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <SectionHeader title="Plans overview" count={plans.length} />
          {plans.length === 0 ? (
            <p className="px-5 py-8 text-sm text-gray-400">No plans yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <TH>Patient</TH>
                    <TH>Practice</TH>
                    <TH>Reference</TH>
                    <TH>Total</TH>
                    <TH>Status</TH>
                    <TH>Progress</TH>
                    <TH>Created</TH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {plans.map((plan) => {
                    const cfg = PLAN_CFG[plan.status] ?? { label: plan.status, cls: 'bg-gray-100 text-gray-600' };
                    return (
                      <tr key={plan.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-2.5 font-medium text-gray-900 whitespace-nowrap">
                          {fullName(plan.profiles)}
                        </td>
                        <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">
                          {practiceName(plan.practices)}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <span className="block font-mono text-xs text-gray-700">{plan.invoice_number ?? '—'}</span>
                          {plan.practice_reference && (
                            <span className="block text-xs text-gray-400 mt-0.5">Ref: {plan.practice_reference}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums text-gray-900 whitespace-nowrap">
                          {formatRand(Number(plan.total_amount))}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <Badge {...cfg} />
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap tabular-nums">
                          {planProgress(plan)}
                        </td>
                        <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">
                          {formatDateTime(plan.created_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Payouts to practices ── */}
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <SectionHeader title="Payouts to practices" count={payouts.length} />
          {payouts.length === 0 ? (
            <p className="px-5 py-8 text-sm text-gray-400">No payouts yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <TH>Practice</TH>
                    <TH>Patient</TH>
                    <TH>Gross</TH>
                    <TH>Fee</TH>
                    <TH>Net</TH>
                    <TH>Status</TH>
                    <TH>Created</TH>
                    <TH>Action</TH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {payouts.map((payout) => {
                    const planRef = Array.isArray(payout.plans) ? payout.plans[0] : payout.plans;
                    const cfg     = PAYOUT_CFG[payout.status] ?? { label: payout.status, cls: 'bg-gray-100 text-gray-600' };
                    return (
                      <tr key={payout.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-2.5 font-medium text-gray-900 whitespace-nowrap">
                          {practiceName(payout.practices)}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <span className="block text-gray-600">{fullName(planRef?.profiles ?? null)}</span>
                          {planRef?.invoice_number && (
                            <span className="block font-mono text-xs text-gray-400 mt-0.5">{planRef.invoice_number}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums text-gray-700 whitespace-nowrap">
                          {formatRand(Number(payout.gross_amount))}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums text-gray-500 whitespace-nowrap">
                          −{formatRand(Number(payout.fee_amount))}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums font-medium text-gray-900 whitespace-nowrap">
                          {formatRand(Number(payout.net_amount))}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <Badge {...cfg} />
                        </td>
                        <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">
                          {formatDateTime(payout.created_at)}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          {payout.status === 'pending' && (
                            <ActionButton
                              id={payout.id}
                              label="Mark paid"
                              loadingLabel="Marking…"
                              action={markPayoutPaid}
                              variant="green"
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </main>
    </div>
  );
}
