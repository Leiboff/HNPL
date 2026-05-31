import { createClient } from '@/lib/supabase/server';
import PatientSignupForm from './PatientSignupForm';

type Props = {
  searchParams: Promise<{ token?: string }>;
};

export default async function PatientSignupPage({ searchParams }: Props) {
  const { token } = await searchParams;

  let invitation: { email: string; practiceName: string | null } | null = null;

  if (token) {
    const supabase = await createClient();
    const { data } = await supabase
      .from('patient_invitations')
      .select('email, practices(name)')
      .eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .is('accepted_at', null)
      .maybeSingle();

    if (data) {
      const practiceRow = data.practices as unknown as { name: string } | null;
      invitation = {
        email:        data.email,
        practiceName: practiceRow?.name ?? null,
      };
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        <div className="mb-7">
          <span className="text-lg font-bold" style={{ color: '#0F4C75' }}>BetterNow</span>
          <h1 className="mt-3 text-2xl font-semibold text-gray-900">Create your account</h1>
          <p className="mt-1 text-sm text-gray-500">
            Interest-free medical payment plans.
          </p>
        </div>

        <PatientSignupForm
          invitation={invitation}
          token={token ?? null}
        />
      </div>
    </div>
  );
}
