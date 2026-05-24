import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export default async function PaymentMethodsPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-gray-900">Payment Methods</h1>
      <p className="mt-2 text-gray-500">Manage your cards here.</p>
    </div>
  );
}
