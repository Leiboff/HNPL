import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { splitInstalments, calculateFee, calculatePaymentDates } from '@/lib/finance';
import BillForm from './BillForm';

type CreateBillInput = {
  patientEmail: string;
  billAmount: number;
  planType: 2 | 3;
};

export type CreateBillSummary = {
  instalments: number[];
  dueDates: string[];
  gross: number;
  fee: number;
  net: number;
  patientName: string;
};

export type CreateBillResult = {
  error: string | null;
  summary?: CreateBillSummary;
};

function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function createBill(data: CreateBillInput): Promise<CreateBillResult> {
  'use server';

  const { patientEmail, billAmount, planType } = data;

  if (!patientEmail || typeof patientEmail !== 'string') {
    return { error: 'Patient email is required.' };
  }
  if (!Number.isFinite(billAmount) || billAmount < 500 || billAmount > 50000) {
    return { error: 'Bill amount must be between R500 and R50 000.' };
  }
  if (planType !== 2 && planType !== 3) {
    return { error: 'Plan type must be 2 or 3 instalments.' };
  }

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Session expired. Please log in again.' };
  }

  const { data: membership } = await supabase
    .from('practice_members')
    .select('practice_id')
    .eq('user_id', user.id)
    .eq('active', true)
    .single();

  if (!membership) {
    return { error: 'You are not a member of any active practice.' };
  }

  const practiceId = membership.practice_id as string;

  const { data: practice } = await supabase
    .from('practices')
    .select('fee_percent')
    .eq('id', practiceId)
    .single();

  if (!practice) {
    return { error: 'Practice not found.' };
  }

  const feePercent = Number(practice.fee_percent);

  const { data: patient } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, salary_day')
    .eq('email', patientEmail.trim().toLowerCase())
    .eq('role', 'patient')
    .maybeSingle();

  if (!patient) {
    return { error: 'No patient found with that email. Ask them to sign up first.' };
  }

  if (patient.salary_day === null || patient.salary_day === undefined) {
    return { error: 'This patient has not set their salary date yet. Ask them to set it in their dashboard first.' };
  }

  const { gross, fee, net } = calculateFee(billAmount, feePercent);
  const instalments = splitInstalments(billAmount, planType);
  const paymentDates = calculatePaymentDates(new Date(), patient.salary_day as number, planType);
  const dueDates = paymentDates.map(formatDate);

  const applicationId = crypto.randomUUID();

  const { error: appError } = await supabase
    .from('applications')
    .insert({
      id: applicationId,
      patient_id: patient.id,
      practice_id: practiceId,
      bill_amount: billAmount,
      plan_type: planType,
      status: 'approved',
      approved_at: new Date().toISOString(),
    });

  if (appError) {
    return { error: `Failed to create application: ${appError.message}` };
  }

  const planId = crypto.randomUUID();

  const { error: planError } = await supabase
    .from('plans')
    .insert({
      id: planId,
      application_id: applicationId,
      patient_id: patient.id,
      practice_id: practiceId,
      total_amount: billAmount,
      plan_type: planType,
      instalment_amount: instalments[0],
      status: 'pending_acceptance',
    });

  if (planError) {
    await supabase.from('applications').delete().eq('id', applicationId);
    return { error: `Failed to create plan: ${planError.message}` };
  }

  const paymentRows = instalments.map((amount, i) => ({
    id: crypto.randomUUID(),
    plan_id: planId,
    patient_id: patient.id,
    instalment_number: i + 1,
    amount,
    due_date: dueDates[i],
    status: 'scheduled',
  }));

  const { error: paymentsError } = await supabase
    .from('payments')
    .insert(paymentRows);

  if (paymentsError) {
    await supabase.from('plans').delete().eq('id', planId);
    await supabase.from('applications').delete().eq('id', applicationId);
    return { error: `Failed to schedule payments: ${paymentsError.message}` };
  }

  return {
    error: null,
    summary: {
      instalments,
      dueDates,
      gross,
      fee,
      net,
      patientName: `${patient.first_name} ${patient.last_name}`,
    },
  };
}

type PracticeInfo = { id: string; name: string; fee_percent: number };

export default async function NewBillPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'practice_admin' && profile?.role !== 'practice_staff') {
    if (profile?.role === 'patient') redirect('/patient');
    else if (profile?.role === 'admin') redirect('/admin');
    else redirect('/login');
  }

  const { data: membership } = await supabase
    .from('practice_members')
    .select('practice_id, practices(id, name, fee_percent)')
    .eq('user_id', user.id)
    .eq('active', true)
    .single();

  if (!membership) {
    redirect('/practice');
  }

  const practice = membership.practices as unknown as PracticeInfo | null;
  if (!practice) {
    redirect('/practice');
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-3xl px-6 py-4 flex items-center justify-between">
          <div>
            <span className="text-lg font-semibold text-gray-900">HNPL</span>
            <span className="ml-2 text-sm text-gray-500">— {practice.name}</span>
          </div>
          <a href="/practice" className="text-sm text-blue-600 hover:text-blue-700">
            ← Back to dashboard
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold text-gray-900">New Bill</h1>
          <p className="mt-2 text-gray-500">
            Create a payment plan for a patient. They will be charged in{' '}
            <span className="font-medium">interest-free instalments</span> around their salary date.
          </p>
        </div>

        <BillForm feePercent={Number(practice.fee_percent)} createBill={createBill} />
      </main>
    </div>
  );
}
