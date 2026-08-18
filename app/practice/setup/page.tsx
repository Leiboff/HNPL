import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import SetupForm from './SetupForm';

type PracticeFormData = {
  practiceId: string;
  name: string;
  specialty: string;
  hpcsaNumber: string;
  phone: string;
  bankName: string;
  bankAccountNumber: string;
  branchCode: string;
};

async function createPractice(data: PracticeFormData): Promise<{ error: string | null }> {
  'use server';

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Session expired. Please log in again.' };
  }

  const { error: practiceError } = await supabase
    .from('practices')
    .insert({
      id: data.practiceId,
      owner_id: user.id,
      name: data.name,
      specialty: data.specialty,
      hpcsa_number: data.hpcsaNumber || null,
      phone: data.phone,
      email: user.email,
      bank_name: data.bankName,
      bank_account_number: data.bankAccountNumber,
      branch_code: data.branchCode,
      status: 'approved',
    });

  if (practiceError) {
    return { error: practiceError.message };
  }

  const { error: memberError } = await supabase
    .from('practice_members')
    .insert({
      practice_id: data.practiceId,
      user_id: user.id,
      role: 'admin',
      active: true,
    });

  if (memberError) {
    // Roll back the practice row so the user can retry cleanly.
    await supabase.from('practices').delete().eq('id', data.practiceId);
    return { error: memberError.message };
  }

  return { error: null };
}

export default async function PracticeSetupPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/practice/setup' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'practice_admin') {
    redirect('/practice');
  }

  // ── Membership + orphan check, one wave ───────────────────────────────
  //
  // Both are keyed on user.id alone and neither needs the other's answer.
  // Pairing them saves a round trip on the path this page exists for — a new
  // practice admin with no membership yet, who renders the setup form.
  //
  // The redirect ORDER is unchanged and that matters, because the second read
  // leads to a WRITE. `if (membership)` is still evaluated first, so a caller
  // who already has a membership is still bounced before the self-heal insert
  // below can be reached. All they cost is one concurrent read whose result is
  // dropped — a stale-bookmark path, not the one this page serves.
  const [{ data: membership }, { data: ownedPractice }] = await Promise.all([
    supabase
      .from('practice_members')
      .select('id')
      .eq('user_id', user.id)
      .eq('active', true)
      .single(),
    // Detect an orphaned practice: the practices insert succeeded on a previous
    // attempt but the practice_members insert failed. Self-heal by creating the
    // missing member row and sending the user straight to the dashboard.
    supabase
      .from('practices')
      .select('id')
      .eq('owner_id', user.id)
      .maybeSingle(),
  ]);

  if (membership) {
    redirect('/practice');
  }

  if (ownedPractice) {
    await supabase.from('practice_members').insert({
      practice_id: ownedPractice.id,
      user_id: user.id,
      role: 'admin',
      active: true,
    });
    redirect('/practice');
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <span className="text-lg font-semibold text-gray-900">BetterNow</span>
          <h1 className="mt-4 text-2xl font-semibold text-gray-900">
            Set up your practice
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            We need a few details before you can start offering payment plans.
          </p>
        </div>
        <SetupForm createPractice={createPractice} />
      </div>
    </div>
  );
}
