import crypto from 'crypto';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { calculateFee } from '@/lib/finance';
import BillForm from './BillForm';

type CreateBillInput = {
  patientEmail:      string;
  billAmount:        number;
  practiceReference?: string;
  providerId:        string;
};

export type InvitationSummary = {
  email:     string;
  token:     string;
  expiresAt: string;
  shareUrl:  string;
};

export type CreateBillSummary = {
  gross:             number;
  fee:               number;
  net:               number;
  patientName:       string;
  invoiceNumber:     string;
  practiceReference?: string;
  invitation?:       InvitationSummary;
};

export type CreateBillResult = {
  error:    string | null;
  summary?: CreateBillSummary;
};

export type ProviderOption = {
  userId:    string;
  firstName: string;
  lastName:  string;
};

async function createBill(data: CreateBillInput): Promise<CreateBillResult> {
  'use server';

  const { patientEmail, billAmount, practiceReference, providerId } = data;

  if (!patientEmail || typeof patientEmail !== 'string') {
    return { error: 'Patient email is required.' };
  }
  if (!Number.isFinite(billAmount) || billAmount < 500 || billAmount > 50000) {
    return { error: 'Bill amount must be between R500 and R50 000.' };
  }
  if (!providerId) {
    return { error: 'A healthcare provider must be selected.' };
  }

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { data: membership } = await supabase
    .from('practice_members')
    .select('practice_id')
    .eq('user_id', user.id)
    .eq('active', true)
    .single();

  if (!membership) return { error: 'You are not a member of any active practice.' };

  const practiceId = membership.practice_id as string;

  const { data: practice } = await supabase
    .from('practices')
    .select('fee_percent')
    .eq('id', practiceId)
    .single();

  if (!practice) return { error: 'Practice not found.' };

  // Verify the selected provider belongs to this practice
  const { data: providerMember } = await supabase
    .from('practice_members')
    .select('user_id')
    .eq('practice_id', practiceId)
    .eq('user_id', providerId)
    .eq('active', true)
    .maybeSingle();

  if (!providerMember) return { error: 'Selected provider is not a member of this practice.' };

  const feePercent = Number(practice.fee_percent);

  const { data: patient } = await supabase
    .from('profiles')
    .select('id, first_name, last_name')
    .eq('email', patientEmail.trim().toLowerCase())
    .eq('role', 'patient')
    .maybeSingle();

  const { gross, fee, net } = calculateFee(billAmount, feePercent);

  const { data: invoiceNumber, error: invoiceError } = await supabase.rpc('next_invoice_number');
  if (invoiceError || !invoiceNumber) {
    return { error: 'Failed to generate invoice number. Please try again.' };
  }

  const applicationId = crypto.randomUUID();
  const { error: appError } = await supabase.from('applications').insert({
    id:          applicationId,
    patient_id:  patient?.id ?? null,
    practice_id: practiceId,
    bill_amount: billAmount,
    status:      'pending',
  });
  if (appError) return { error: `Failed to create application: ${appError.message}` };

  const planId = crypto.randomUUID();
  const { error: planError } = await supabase.from('plans').insert({
    id:                 planId,
    application_id:     applicationId,
    patient_id:         patient?.id ?? null,
    practice_id:        practiceId,
    provider_id:        providerId,
    total_amount:       billAmount,
    status:             'pending_acceptance',
    invoice_number:     invoiceNumber,
    practice_reference: practiceReference?.trim() || null,
  });
  if (planError) {
    await supabase.from('applications').delete().eq('id', applicationId);
    return { error: `Failed to create plan: ${planError.message}` };
  }

  const trimmedRef = practiceReference?.trim() || undefined;

  // ── Scenario A: existing patient ─────────────────────────────────────────
  if (patient) {
    return {
      error: null,
      summary: {
        gross,
        fee,
        net,
        patientName:       `${patient.first_name} ${patient.last_name}`,
        invoiceNumber,
        practiceReference: trimmedRef,
      },
    };
  }

  // ── Scenario B: new patient — create invitation ──────────────────────────
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { error: inviteError } = await supabase.from('patient_invitations').insert({
    email:       patientEmail.trim().toLowerCase(),
    plan_id:     planId,
    practice_id: practiceId,
    provider_id: providerId,
    token,
    expires_at:  expiresAt,
  });

  if (inviteError) {
    console.error('[createBill] Failed to create invitation', inviteError.message);
  }

  const appUrl   = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const shareUrl = `${appUrl}/signup/patient?token=${token}`;

  return {
    error: null,
    summary: {
      gross,
      fee,
      net,
      patientName:       patientEmail.trim().toLowerCase(),
      invoiceNumber,
      practiceReference: trimmedRef,
      invitation: { email: patientEmail.trim().toLowerCase(), token, expiresAt, shareUrl },
    },
  };
}

type PracticeInfo = { id: string; name: string; fee_percent: number };

export default async function NewBillPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'practice_admin' && profile?.role !== 'practice_staff') {
    if (profile?.role === 'patient')  redirect('/patient');
    else if (profile?.role === 'admin') redirect('/admin');
    else redirect('/login');
  }

  const { data: membership } = await supabase
    .from('practice_members')
    .select('practice_id, practices(id, name, fee_percent)')
    .eq('user_id', user.id)
    .eq('active', true)
    .single();

  if (!membership) redirect('/practice');

  const practice = membership.practices as unknown as PracticeInfo | null;
  if (!practice) redirect('/practice');

  const practiceId = membership.practice_id as string;

  // Fetch active providers for this practice
  const { data: memberRows } = await supabase
    .from('practice_members')
    .select('user_id, profiles(first_name, last_name)')
    .eq('practice_id', practiceId)
    .eq('active', true)
    .in('role', ['admin', 'provider']);

  const providers: ProviderOption[] = (memberRows ?? []).map((m: any) => {
    const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
    return {
      userId:    m.user_id as string,
      firstName: p?.first_name ?? '',
      lastName:  p?.last_name  ?? '',
    };
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-3xl px-6 py-4 flex items-center justify-between">
          <div>
            <span className="text-lg font-semibold text-gray-900">BetterNow</span>
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

        <BillForm
          feePercent={Number(practice.fee_percent)}
          providers={providers}
          createBill={createBill}
        />
      </main>
    </div>
  );
}
