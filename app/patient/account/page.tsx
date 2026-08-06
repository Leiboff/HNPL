import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PatientScreen from '../PatientScreen';
import InstalmentLadder, { type LadderSegment } from '../InstalmentLadder';
import ProfileLogoutSection from '../profile/ProfileLogoutSection';
import PaymentMethods from '../payment-methods/PaymentMethods';
import { initializeCardRegistration } from '../actions';
import { deriveInstalmentStatus } from '@/lib/patient/instalmentStatus';
import { todaySAST } from '../_format';
import {
  previewDefaultChange,
  changeDefaultCard,
  removeCard,
  type CardRow,
} from '../payment-methods/page';

// ─── Account (v4 screen 06) ──────────────────────────────────────────────
//
// Cards and Profile merge into one Account tab. A navy header carries the
// identity; the sheet holds an honest payment record, the saved cards
// (the existing PaymentMethods surface), and a flat list of settings rows.
//
// Honesty (per the build decision): the "Your record" card shows the
// count of payments actually made — no invented rewards tier, and NO
// "we'll review your limit" promise (that policy doesn't exist in code).
//
// The deeper editors (payday, personal details, notifications, security)
// live on their own routes and are reached from the settings rows —
// matching the design's tap-through rows.

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#B6C1CD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function SettingRow({ href, title, sub, external = false }: { href: string; title: string; sub?: string; external?: boolean }) {
  const inner = (
    <>
      <div className="min-w-0">
        <p className="text-[14.5px] font-semibold" style={{ color: '#13294B' }}>{title}</p>
        {sub && <p className="mt-0.5 text-[12.5px]" style={{ color: '#8496AA' }}>{sub}</p>}
      </div>
      <Chevron />
    </>
  );
  const cls = 'flex items-center justify-between gap-3 px-[18px] py-[17px] hover:bg-gray-50 transition-colors';
  return external
    ? <a href={href} className={cls} style={{ borderTop: '1px solid #EEF2F5' }}>{inner}</a>
    : <Link href={href} className={cls} style={{ borderTop: '1px solid #EEF2F5' }}>{inner}</Link>;
}

export default async function AccountPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: profile }, { data: rawCards }, { data: rawPayments }] = await Promise.all([
    supabase.from('profiles').select('first_name, last_name, email, salary_day').eq('id', user.id).single(),
    supabase
      .from('payment_methods')
      .select('id, card_brand, last_four, expiry_month, expiry_year, cardholder_name, is_default, created_at')
      .eq('patient_id', user.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase.from('payments').select('status, due_date, next_attempt_date').eq('patient_id', user.id).eq('kind', 'instalment'),
  ]);

  const firstName = (profile?.first_name as string | null) ?? '';
  const lastName  = (profile?.last_name  as string | null) ?? '';
  const fullName  = [firstName, lastName].filter(Boolean).join(' ') || '—';
  const initials  = [firstName[0], lastName[0]].filter(Boolean).join('').toUpperCase() || '?';
  const salaryDay = (profile?.salary_day as number | null) ?? null;
  const paydayLabel =
    salaryDay == null   ? 'Not set yet' :
    salaryDay >= 31     ? 'Last day of the month' :
                          `Day ${salaryDay} of the month`;

  const cards = (rawCards ?? []) as CardRow[];

  // ── Honest payment record ─────────────────────────────────────────
  // "All on time" is only true when nothing is currently overdue AND there
  // is no history of a miss. Overdue is derived (due date vs today) via the
  // shared source of truth — the same verdict the Plans header and schedule
  // show — so this card can never contradict them.
  const today       = todaySAST();
  const instalments = (rawPayments ?? []) as { status: string; due_date: string; next_attempt_date: string | null }[];
  const statuses    = instalments.map((p) => p.status);
  const madeCount   = statuses.filter((s) => s === 'collected').length;
  const scheduled   = statuses.filter((s) => s === 'scheduled').length;
  const everMissed  = statuses.some((s) => s === 'failed' || s === 'defaulted' || s === 'retried');
  const anyOverdue  = instalments.some((p) => deriveInstalmentStatus(p, today) === 'overdue');
  const cleanRecord = madeCount > 0 && !everMissed && !anyOverdue;

  const CAP = 8;
  const paidSeg   = Math.min(madeCount, CAP);
  const comingSeg = Math.min(scheduled, CAP - paidSeg);
  const recordSegments: LadderSegment[] = [
    ...Array(paidSeg).fill('paid' as LadderSegment),
    ...Array(comingSeg).fill('coming' as LadderSegment),
  ];

  const recordHeading =
    madeCount === 0 ? 'No payments yet' :
    cleanRecord     ? `${madeCount} payment${madeCount === 1 ? '' : 's'}, all on time` :
                      `${madeCount} payment${madeCount === 1 ? '' : 's'} made`;

  const header = (
    <div className="flex items-center gap-[14px]">
      <span
        className="flex-none w-[52px] h-[52px] rounded-full flex items-center justify-center text-[17px] font-semibold text-white"
        style={{ background: 'rgba(255,255,255,.14)' }}
      >
        {initials}
      </span>
      <div className="min-w-0">
        <p className="text-[19px] font-semibold text-white truncate" style={{ letterSpacing: '-.02em' }}>{fullName}</p>
        <p className="mt-0.5 text-[13px] truncate" style={{ color: 'rgba(255,255,255,.6)' }}>{profile?.email ?? ''}</p>
      </div>
    </div>
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <div className="flex flex-col gap-[14px]">

        {/* Your record */}
        <div
          className="rounded-[22px] bg-white p-[18px] flex flex-col gap-[14px]"
          style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.5)' }}>Your record</p>
              <p className="mt-2 text-[17px] font-semibold" style={{ color: '#13294B' }}>{recordHeading}</p>
            </div>
            {cleanRecord && (
              <span className="flex-none w-[34px] h-[34px] rounded-full flex items-center justify-center" style={{ background: 'rgba(21,168,158,.13)', color: '#0F766E' }}>
                <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 10.5l3 3 7-7" />
                </svg>
              </span>
            )}
          </div>
          {recordSegments.length > 0 && <InstalmentLadder segments={recordSegments} />}
          <p className="text-[13px] leading-[1.55]" style={{ color: '#8496AA' }}>
            {madeCount === 0
              ? 'Your payment record builds here as you pay each instalment on time.'
              : 'Every payment you keep on time builds your record with betternow.'}
          </p>
        </div>

        {/* How you pay — the existing saved-card surface */}
        <div className="flex flex-col gap-[10px]">
          <p className="text-[11px] font-semibold uppercase px-1" style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.5)' }}>How you pay</p>
          <PaymentMethods
            initialCards={cards}
            initializeCardRegistration={initializeCardRegistration}
            previewDefaultChange={previewDefaultChange}
            changeDefaultCard={changeDefaultCard}
            removeCard={removeCard}
          />
        </div>

        {/* Settings */}
        <div
          className="rounded-[22px] bg-white overflow-hidden"
          style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        >
          <SettingRow href="/patient/profile" title="Payday" sub={paydayLabel} />
          <SettingRow href="/patient/profile" title="Your details" sub="Cell number, personal info" />
          <SettingRow href="/patient/profile" title="Notifications" />
          <SettingRow href="/patient/profile" title="Sign in & security" />
          <SettingRow href="mailto:support@betternow.co.za" title="Get help" external />
        </div>

        <ProfileLogoutSection />

      </div>
    </PatientScreen>
  );
}
