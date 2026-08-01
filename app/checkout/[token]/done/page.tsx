import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import PasswordSetForm from './PasswordSetForm';
import StepMedallion from '../_components/StepMedallion';
import { finalizePassword } from '../actions';

// ─── /checkout/[token]/done ────────────────────────────────────────────────
//
// Final step: the bill has been paid, the plan is active, the invitation
// is claimed. The patient is signed in via a temp password that
// initiateCheckout / complete set on their behalf.
//
// The SUCCESS is the hero here — an unmissable "your plan is active"
// confirmation with the amount paid, the remaining schedule, and the
// practice name. Setting a password is a clearly SECONDARY, skippable
// next step below it: it must never bury or gate the confirmation.
//
// Skipping is safe: the account's email is already confirmed (the emailed
// checkout link proved possession), so the patient can always get back in
// via /login's "Forgot password" email reset — and the patient portal
// surfaces the passkey prompt post-login, a better durable credential for
// this cohort. (There is no email-OTP/magic-link login today; see the
// task report for that recommendation.)

type Params = { token: string };

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

type ScheduleRow = { instalment_number: number; amount: number; due_date: string | null };

// Best-effort read of the just-paid plan for the success hero. Non-fatal:
// any failure just renders the plain "your plan is active" hero without
// amounts — the confirmation itself must never depend on this lookup.
async function loadPlanSummary(token: string): Promise<{
  practiceName:     string | null;
  amountPaid:       number | null;
  remaining:        Array<{ amount: number; date: string }>;
} | null> {
  try {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );

    const { data: invitation } = await svc
      .from('patient_invitations')
      .select('plan_id, practice_id')
      .eq('token', token)
      .maybeSingle();
    if (!invitation?.plan_id) return null;

    const [{ data: rows }, { data: practice }] = await Promise.all([
      svc
        .from('payments')
        .select('instalment_number, amount, due_date')
        .eq('plan_id', invitation.plan_id as string)
        .order('instalment_number', { ascending: true }),
      svc
        .from('practices')
        .select('name')
        .eq('id', invitation.practice_id as string)
        .maybeSingle(),
    ]);

    const schedule = (rows ?? []) as ScheduleRow[];
    const first    = schedule.find((r) => r.instalment_number === 1);
    const remaining = schedule
      .filter((r) => r.instalment_number > 1 && r.due_date)
      .map((r) => ({ amount: Number(r.amount), date: formatShortDate(r.due_date as string) }))
      .filter((r) => r.date !== '');

    return {
      practiceName: (practice?.name as string | null) ?? null,
      amountPaid:   first ? Number(first.amount) : null,
      remaining,
    };
  } catch {
    return null;
  }
}

export default async function CheckoutDonePage({ params }: { params: Promise<Params> }) {
  const { token } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // No session means something went wrong in the roundtrip. Route them to
  // /login. The plan is already active under their account either way (the
  // complete page wrote the rows before redirecting).
  if (!user) {
    redirect(`/login?next=${encodeURIComponent('/patient')}`);
  }

  const summary = await loadPlanSummary(token);

  return (
    <div className="min-h-screen bg-[#FAFBFD]">
      <header className="bg-white border-b border-[#E5E9F0]">
        <div className="mx-auto max-w-md px-5 py-4">
          <span
            className="text-lg font-bold tracking-tight"
            style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
          >
            <span style={{ color: '#13294B' }}>better</span>
            <span style={{ color: '#15A89E' }}>now</span>
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-md px-5 py-8 sm:py-12 space-y-5">
        {/* ── Success HERO — the moment of relief, unmissable ─────────── */}
        <section
          data-testid="checkout-success-hero"
          className="rounded-[20px] border border-[#E5E9F0] bg-white p-6 sm:p-7 shadow-[0_1px_2px_rgba(15,31,58,0.04)] space-y-5"
        >
          <div className="flex items-center gap-4">
            <StepMedallion icon="check" tone="green" />
            <div>
              <h1 className="text-xl font-semibold text-[#0F1F3A] tracking-[-0.01em]">
                Payment successful — your plan is active
              </h1>
              <p className="mt-0.5 text-sm text-[#3A4B66]">
                {summary?.practiceName
                  ? <>Thanks — {summary.practiceName} has been notified.</>
                  : <>Thanks — you&apos;re all set.</>}
              </p>
            </div>
          </div>

          {summary?.amountPaid != null && (
            <div className="rounded-xl bg-[#F1FAF8] border border-[#CDEDE7] p-4">
              <p className="text-xs uppercase tracking-[0.08em] font-medium text-[#3E7C73]">
                Paid today
              </p>
              <p className="mt-1 text-3xl font-semibold tabular-nums text-[#13294B]">
                {formatRand(summary.amountPaid)}
              </p>
            </div>
          )}

          {summary && summary.remaining.length > 0 && (
            <div data-testid="checkout-success-schedule">
              <p className="text-xs uppercase tracking-[0.08em] font-medium text-[#7A8AA0] mb-2">
                Remaining instalments
              </p>
              <ul className="space-y-1.5">
                {summary.remaining.map((r, i) => (
                  <li key={i} className="flex items-center justify-between text-sm">
                    <span className="text-[#3A4B66]">{r.date}</span>
                    <span className="font-medium tabular-nums text-[#0F1F3A]">{formatRand(r.amount)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-[#7A8AA0]">
                We&apos;ll collect these automatically from your saved card — no action needed.
              </p>
            </div>
          )}
        </section>

        {/* ── SECONDARY: optional password, fully skippable ──────────── */}
        <PasswordSetForm
          email={user.email ?? ''}
          finalizePassword={finalizePassword}
        />
      </main>
    </div>
  );
}
