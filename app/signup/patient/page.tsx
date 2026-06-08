import { createClient } from '@/lib/supabase/server';
import Link from 'next/link';
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
    <div
      className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{
        background: '#f7fbfb',
        backgroundImage: 'radial-gradient(58% 48% at 84% 0%, rgba(21,168,158,.12), transparent 70%), radial-gradient(48% 42% at 4% 90%, rgba(19,41,75,.07), transparent 70%)',
      }}
    >
      <div className="w-full max-w-md">

        {/* Brand mark */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-block text-2xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
            <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
          </Link>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200/80 p-8">
          <div className="mb-7">
            <h1 className="text-2xl font-semibold" style={{ color: '#13294B', fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
              Create your account
            </h1>
            <p className="mt-1 text-sm text-gray-500">Interest-free medical payment plans.</p>
          </div>

          <PatientSignupForm invitation={invitation} token={token ?? null} />
        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
          Already have an account?{' '}
          <Link href="/login" className="font-semibold hover:underline" style={{ color: '#13294B' }}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
