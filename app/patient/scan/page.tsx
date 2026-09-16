import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import ScanView from './ScanView';
import { getRequestUser } from '@/lib/auth/requestUser';
import { getPatientProfileForRequest } from '@/lib/patient/requestProfile';
import { availableBalance, type PaymentForBalance } from '@/lib/patient/approvedBalance';
import { formatRand } from '../_format';

// ─── /patient/scan ─────────────────────────────────────────────────────
//
// The centre tab of the mobile bottom nav (see ../PatientBottomNav.tsx).
//
// This is the one patient screen that is NOT on the light sheet. It is a
// camera viewfinder: a near-black canvas is what lets the preview read as
// a preview instead of a photo pasted into a card, and it is the state the
// phone's own camera UI puts a person in. So it does not go through
// PatientScreen at all — there is no navy hero and no sheet to lift, and
// wrapping a full-bleed viewfinder in one would produce a dark band above
// a light card holding a darker rectangle.
//
// It DOES fetch: the available balance. Standing at a practice's till is
// exactly where a patient cannot go and look up what they can spend, and
// it is the number they are about to be asked to commit against. Same
// query set and same helper as the home hero, so the two cannot disagree.
// With no approved limit the pill does not render — never a placeholder.

export default async function ScanPage() {
  const user = await getRequestUser();
  if (!user) redirect('/login');

  const supabase = await createClient();

  const [profile, { data: rawPlans }, { data: rawPayments }] = await Promise.all([
    // Request-scoped memo — the layout already read this row, so it costs
    // no second round trip. See lib/patient/requestProfile.ts.
    getPatientProfileForRequest(user.id),
    supabase.from('plans').select('id, status').eq('patient_id', user.id).eq('status', 'active'),
    supabase
      .from('payments')
      .select('amount, status, plan_id')
      .eq('patient_id', user.id)
      .eq('kind', 'instalment')
      .in('status', ['scheduled', 'processing', 'failed', 'defaulted']),
  ]);

  const approvedLimit = (profile?.approved_credit_limit as number | null) ?? null;

  let availableLabel: string | null = null;
  if (approvedLimit != null) {
    const activePlanIds = new Set(((rawPlans ?? []) as { id: string }[]).map((p) => p.id));
    const payments: PaymentForBalance[] = ((rawPayments ?? []) as { amount: number | string; status: string; plan_id: string | null }[])
      .filter((p) => p.plan_id != null && activePlanIds.has(p.plan_id))
      .map((p) => ({ amount: Number(p.amount), status: p.status }));
    availableLabel = formatRand(availableBalance(approvedLimit, payments));
  }

  return (
    <div className="bn-app relative" style={{ background: 'var(--portal-viewfinder)', minHeight: '100%' }}>
      <div className="mx-auto w-full max-w-md md:max-w-xl pt-[58px] pb-[118px] flex flex-col items-center">
        <div className="w-full px-[20px] pt-2">
          <Link
            href="/patient"
            aria-label="Back to home"
            className="flex-none inline-flex w-9 h-9 rounded-full items-center justify-center"
            style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.14)' }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 6-6 6 6 6" />
            </svg>
          </Link>
        </div>
        <ScanView availableLabel={availableLabel} />
      </div>
    </div>
  );
}
