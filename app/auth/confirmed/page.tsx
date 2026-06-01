import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

function CheckCircleIcon() {
  return (
    <svg
      className="w-16 h-16"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden
      style={{ color: '#0F4C75' }}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"
      />
    </svg>
  );
}

const ROLE_DESTINATIONS: Record<string, string> = {
  patient:           '/patient',
  practice_admin:    '/practice',
  practice_provider: '/provider',
};

export default async function ConfirmedPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();

  let destination = '/patient';

  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profile?.role && ROLE_DESTINATIONS[profile.role]) {
      destination = ROLE_DESTINATIONS[profile.role];
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-10 text-center">

        <div className="flex justify-center mb-6">
          <CheckCircleIcon />
        </div>

        <h1 className="text-2xl font-semibold text-gray-900 mb-2">
          Email confirmed
        </h1>
        <p className="text-sm text-gray-500 mb-8">
          Your BetterNow account is ready.
        </p>

        <Link
          href={destination}
          className="inline-flex items-center justify-center w-full rounded-xl px-6 py-3 text-sm font-semibold text-white transition-colors"
          style={{ backgroundColor: '#0F4C75' }}
        >
          Continue to dashboard
        </Link>
      </div>
    </div>
  );
}
