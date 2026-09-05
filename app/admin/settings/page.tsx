import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import BillLimitForm from './BillLimitForm';

export default async function AdminSettingsPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin/settings' });
  const [{ data: profile }, { data: settings }] = await Promise.all([
    supabase.from('profiles').select('role').eq('id', user.id).single(),
    supabase.from('platform_settings').select('max_bill_amount').eq('singleton', true).single(),
  ]);
  if (profile?.role !== 'admin') redirect('/dashboard');

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-gray-900">Platform settings</h1>
      <p className="mt-2 text-sm text-gray-600">
        Platform-wide financial controls. Changes require a recent MFA verification and are written to the admin audit log.
      </p>
      <section className="mt-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900">Billing</h2>
        <div className="mt-4">
          <BillLimitForm currentAmount={Number(settings?.max_bill_amount ?? 30000)} />
        </div>
      </section>
    </main>
  );
}
