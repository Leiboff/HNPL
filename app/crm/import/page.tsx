import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import ImportTabs from './ImportTabs';

export default async function ImportPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/crm/import' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'sales' && profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Import leads (CSV)</h1>
        <p className="mt-1 text-sm text-gray-500">
          Upload a CSV of leads. We show you a preview with row-by-row errors and duplicate warnings before anything is written.
          &quot;Full detail&quot; caps at 500 rows and expects a resolved address; &quot;Quick import&quot; caps at 5,000 rows, needs only a
          name, specialty, and rough neighbourhood, and geocodes the neighbourhood to an approximate map position automatically.
        </p>
      </div>
      <ImportTabs />
    </div>
  );
}
