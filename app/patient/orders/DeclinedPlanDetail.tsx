import Link from 'next/link';
import PatientScreen from '@/app/patient/PatientScreen';
import { formatRand } from '@/app/patient/_format';

// ─── Declined-bill detail (v4) ───────────────────────────────────────────
//
// A declined bill is NOT an active plan, so it must never borrow the
// plan-management screen (its timeline, ladder, "left to pay", live card
// row, settle actions, or receipt link). Nothing was charged. This is a
// minimal, honest read: what happened, and what to do next. The only path
// to a declined status is the patient's own "Not mine" decline, so the copy
// says exactly that — there is no stored decline reason to surface.

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#B6C1CD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export default function DeclinedPlanDetail({
  practiceName,
  amount,
  invoiceNumber,
  practiceReference,
}: {
  practiceName:      string;
  amount:            number;
  invoiceNumber:     string | null;
  practiceReference: string | null;
}) {
  // Normalise the merchant name before it's interpolated into copy: collapse
  // internal whitespace runs and trim the ends. A whitespace-dirty value
  // (stray leading/trailing/double spaces from the DB) then can't glue to the
  // adjacent word ("Physiosto send") or render a double space.
  const practice = practiceName.replace(/\s+/g, ' ').trim();

  const refSegments: string[] = [];
  if (invoiceNumber)     refSegments.push(`Ref ${invoiceNumber}`);
  if (practiceReference) refSegments.push(`Practice ref ${practiceReference}`);

  const header = (
    <>
      <div className="flex items-center gap-3">
        <Link
          href="/patient/orders"
          aria-label="Back to plans"
          className="flex-none w-[38px] h-[38px] rounded-full flex items-center justify-center"
          style={{ background: 'rgba(255,255,255,.12)' }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m15 6-6 6 6 6" />
          </svg>
        </Link>
        <span className="text-[15.5px] font-semibold text-white truncate">{practice}</span>
      </div>

      <div className="mt-[24px]">
        <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.18em', color: 'rgba(255,255,255,.55)' }}>
          Declined
        </p>
        <p className="mt-[11px] text-[26px] font-semibold text-white" style={{ letterSpacing: '-.02em' }}>
          You declined this bill
        </p>
        <p className="mt-2 text-[13.5px] tabular-nums" style={{ color: 'rgba(255,255,255,.6)' }}>
          {formatRand(amount)} · no money was taken
        </p>
      </div>
    </>
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <div className="flex flex-col gap-[14px]">

        {/* What happened */}
        <div
          className="rounded-[22px] bg-white p-[18px]"
          style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        >
          <p className="text-[15px] font-semibold" style={{ color: '#13294B' }}>What happened</p>
          <p className="mt-2 text-[13.5px] leading-[1.55]" style={{ color: '#5B6B7F' }}>
            You told us this bill from {practice} wasn&rsquo;t yours, so we didn&rsquo;t set up a
            payment plan and <span className="font-semibold" style={{ color: '#13294B' }}>no money was taken</span>.
          </p>
        </div>

        {/* What to do next */}
        <div
          className="rounded-[22px] bg-white overflow-hidden"
          style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        >
          <div className="px-[18px] pt-[16px] pb-[4px] text-[11px] font-semibold uppercase" style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.5)' }}>
            What to do next
          </div>
          <p className="px-[18px] pb-[15px] text-[13.5px] leading-[1.55]" style={{ color: '#5B6B7F' }}>
            If you declined this by mistake, ask {practice} to send it again — or get in touch and
            we&rsquo;ll help sort it out.
          </p>
          <a
            href="mailto:support@betternow.co.za?subject=Declined bill"
            className="flex items-center justify-between gap-3 px-[18px] py-[16px]"
            style={{ borderTop: '1px solid #EEF2F5' }}
          >
            <span className="text-[14px] font-semibold" style={{ color: '#13294B' }}>Contact support</span>
            <Chevron />
          </a>
        </div>

        {refSegments.length > 0 && (
          <p className="text-center text-[11.5px]" style={{ color: '#A8B4C2' }}>{refSegments.join(' · ')}</p>
        )}

      </div>
    </PatientScreen>
  );
}
