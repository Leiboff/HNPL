import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import ConfirmForm from './ConfirmForm';
import { getRequestUser } from '@/lib/auth/requestUser';
import { outstandingExposure } from '@/lib/underwriting/creditLimit';

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

  const user = await getRequestUser();
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
      // approved_credit_limit is here so the schedule this page RENDERS is
      // the schedule the server will WRITE. Since the allowance model
      // (product decision 2026-09-02) a bill above the patient's remaining
      // headroom is not refused — the excess is collected with instalment 1 —
      // so an equal three-way split shown next to a Pay button would
      // understate the first charge, sometimes by thousands. Readable by the
      // row's owner; already displayed on the dashboard.
      .select('salary_day, approved_credit_limit')
      .eq('id', user.id)
      .single(),
    supabase
      .from('payment_methods')
      .select('id, card_brand, last_four, expiry_month, expiry_year, reusable, is_default')
      .eq('patient_id', user.id)
      .is('archived_at', null)   // don't offer archived cards for a new plan
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
      <div className="bn-app" style={{ background: '#fff', minHeight: '100%' }}>
        <div className="mx-auto w-full max-w-md md:max-w-xl pt-[58px] px-[20px] pb-10">
          <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.18em', color: 'var(--portal-faint)' }}>
            One thing first
          </p>
          <h1 className="mt-[9px] text-[26px] font-bold leading-[1.2]" style={{ letterSpacing: '-.035em', color: 'var(--portal-ink)' }}>
            Set your salary date
          </h1>
          <p className="mt-2.5 text-[13.5px] leading-[1.6]" style={{ color: 'var(--portal-muted)' }}>
            Instalments are collected just after you get paid, so we need your salary
            date before we can schedule them. It takes a moment and you&rsquo;ll come
            straight back to this bill.
          </p>
          <div className="mt-6 flex flex-col gap-[10px]">
            <Link
              href="/patient/account/personal"
              className="bn-btn-teal rounded-tile py-4 text-center text-[15px] font-semibold text-white"
            >
              Set my salary date
            </Link>
            <Link
              href="/patient/orders"
              className="py-2 text-center text-[13px] font-semibold"
              style={{ color: 'var(--portal-muted)' }}
            >
              Back to plans
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

  // ── What this page may promise about the money ───────────────────────────
  //
  // Two different questions, and conflating them is how a patient meets a
  // first charge they were not shown:
  //
  //   RESUME  the schedule already EXISTS. Read it, don't recompute it —
  //           payWithSavedCard re-charges the amount on the row, so any
  //           recomputation here could disagree with what is charged.
  //   FRESH   no schedule yet. The amounts depend on the headroom the claim
  //           will find, so read the headroom the same way the claim's
  //           pre-read does and split against it.
  //
  // Both are best-effort for DISPLAY only. claim_credit_for_plan re-derives
  // everything under a row lock and is the authority; if the headroom moves
  // between this render and the tap, the claim wins and the patient is told.
  let committedInstalments: number[] | null = null;
  let availableRands:       number | null   = null;

  if (resumeMode) {
    const { data: rows } = await supabase
      .from('payments')
      .select('amount, instalment_number')
      .eq('plan_id', planId)
      .eq('kind', 'instalment')
      .order('instalment_number', { ascending: true });
    const amounts = (rows ?? []).map((r) => Number(r.amount));
    if (amounts.length > 0) committedInstalments = amounts;
  } else {
    const rawLimit = profile?.approved_credit_limit as number | string | null | undefined;
    const limit    = rawLimit === null || rawLimit === undefined ? null : Number(rawLimit);
    if (limit !== null && Number.isFinite(limit)) {
      const exposure = await outstandingExposure(supabase, user.id, { excludePlanId: planId });
      // A failed exposure read means we cannot say what the split will be, so
      // we say nothing rather than guessing — ConfirmForm falls back to the
      // fully-financed shape and the claim corrects it.
      if (exposure.ok) {
        availableRands = Math.round((limit - exposure.rands) * 100) / 100;
      }
    } else {
      // No approved limit at all. The claim will refuse with no_limit, so
      // don't render a schedule and a Pay button as if it won't.
      availableRands = 0;
    }
  }

  // No wrapper: ConfirmForm owns the whole screen — its own white canvas,
  // status-bar clearance, back row and step bar. A max-w column here would
  // nest a second, narrower page inside it.
  return (
    <>
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
        availableRands={availableRands}
        committedInstalments={committedInstalments}
      />
    </>
  );
}
