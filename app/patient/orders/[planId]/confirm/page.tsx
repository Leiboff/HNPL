import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import ConfirmForm from './ConfirmForm';

export default async function ConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ planId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ planId }, sp] = await Promise.all([params, searchParams]);
  const planTypeParam = typeof sp.planType === 'string' ? sp.planType : undefined;
  const initialPlanType: 2 | 3 | null =
    planTypeParam === '2' ? 2 : planTypeParam === '3' ? 3 : null;
  const fromRegistration = sp.from === 'registration';
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: rawPlan }, { data: profile }, { data: rawCards }, { data: rawProgress }] = await Promise.all([
    supabase
      .from('plans')
      // pending_acceptance = fresh confirm; pending_first_payment (no
      // stored card) = RESUME of an abandoned saved-card one-click.
      .select('id, total_amount, status, plan_type, peach_registration_id, invoice_number, practice_reference, practices(name)')
      .eq('id', planId)
      .eq('patient_id', user.id)
      .in('status', ['pending_acceptance', 'pending_first_payment'])
      .maybeSingle(),
    supabase
      .from('profiles')
      .select('salary_day')
      .eq('id', user.id)
      .single(),
    supabase
      .from('payment_methods')
      .select('id, card_brand, last_four, expiry_month, expiry_year, reusable, is_default')
      .eq('patient_id', user.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('plans')
      .select('status')
      .eq('patient_id', user.id)
      // Exclude THIS plan — a plan (a resume in pending_first_payment)
      // must never block itself.
      .neq('id', planId)
      .in('status', ['pending_first_payment', 'active', 'completed']),
  ]);

  if (!rawPlan) redirect('/patient/orders');

  // A pending_first_payment plan that ALREADY has a stored card has
  // captured its card (first charge landed / in flight) — not resumable
  // here; its live state shows on the orders page.
  if (rawPlan.status === 'pending_first_payment' && rawPlan.peach_registration_id) {
    redirect('/patient/orders');
  }
  const resumeMode = rawPlan.status === 'pending_first_payment';

  const progressRows = (rawProgress ?? []) as { status: string }[];
  const hasInProgress = progressRows.some(
    (r) => r.status === 'pending_first_payment' || r.status === 'active',
  );
  const hasCompleted = progressRows.some((r) => r.status === 'completed');
  const blocked = hasInProgress && !hasCompleted;

  const practicesRaw = rawPlan.practices as { name: string } | { name: string }[] | null;
  const practiceName = !practicesRaw
    ? 'Unknown Practice'
    : Array.isArray(practicesRaw)
    ? (practicesRaw[0]?.name ?? 'Unknown Practice')
    : practicesRaw.name;

  const salaryDay = (profile?.salary_day as number | null) ?? null;

  if (!salaryDay) {
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm px-8 py-10 space-y-4 text-center">
          <h1 className="text-xl font-semibold text-gray-900">Set your salary date first</h1>
          <p className="text-sm text-gray-600">
            We need your salary date to schedule your instalment payments around your payday.
          </p>
          <div className="flex flex-col items-center gap-3">
            <Link
              href="/patient/account?section=personal"
              className="inline-flex items-center justify-center rounded-lg px-6 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              Go to account →
            </Link>
            <Link href="/patient/orders" className="text-sm text-gray-500 hover:underline">
              Back to orders
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const cards = (rawCards ?? []).map((c) => ({
    id:            c.id as string,
    card_brand:    (c.card_brand ?? '') as string,
    last_four:     (c.last_four ?? '') as string,
    expiry_month:  Number(c.expiry_month),
    expiry_year:   Number(c.expiry_year),
    reusable:      Boolean(c.reusable),
    is_default:    Boolean(c.is_default),
  }));

  // On resume, the instalment count was fixed at first acceptance — use it.
  const resolvedPlanType: 2 | 3 | null =
    resumeMode ? ((rawPlan.plan_type as 2 | 3 | null) ?? initialPlanType) : initialPlanType;

  return (
    <div className="mx-auto max-w-xl px-6 py-10">
      <ConfirmForm
        planId={planId}
        totalAmount={Number(rawPlan.total_amount)}
        practiceName={practiceName}
        invoiceNumber={rawPlan.invoice_number as string | null}
        salaryDay={salaryDay}
        cards={cards}
        initialPlanType={resolvedPlanType}
        fromRegistration={fromRegistration}
        blocked={blocked}
        resumeMode={resumeMode}
      />
    </div>
  );
}
