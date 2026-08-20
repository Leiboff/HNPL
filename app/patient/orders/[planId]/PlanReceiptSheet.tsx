'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatRand, formatDate } from '@/app/patient/_format';

// ─── Plan receipt — a bottom sheet, triggered from the plan detail card ────
//
// The row it replaces ("Something wrong with this bill?") pointed at
// support email, not a receipt. This is the receipt itself: what the plan
// was for, its total, when it started, and the same reference numbers the
// page already prints below the card — restated here because a receipt
// that only exists as small grey text under a button isn't one a patient
// would screenshot or forward.

type Props = {
  practiceName:      string;
  amount:            number;
  /** Mirrors PlanProgress.isPaidInFull — status === 'completed'. */
  isPaidInFull:      boolean;
  /** YYYY-MM-DD — plans.created_at, date-sliced. */
  createdDate:       string;
  invoiceNumber:     string | null;
  practiceReference: string | null;
};

export default function PlanReceiptSheet({
  practiceName,
  amount,
  isPaidInFull,
  createdDate,
  invoiceNumber,
  practiceReference,
}: Props) {
  const [open, setOpen] = useState(false);

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [open, handleKey]);

  const refSegments: string[] = [];
  if (invoiceNumber)     refSegments.push(`Ref ${invoiceNumber}`);
  if (practiceReference) refSegments.push(`Practice ref ${practiceReference}`);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center justify-between gap-3 px-[18px] py-[16px] w-full text-left"
        style={{ borderTop: '1px solid #EEF2F5' }}
      >
        <span className="flex items-center gap-2.5">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#13294B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 3h9l3 3v15l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5V3Z" />
            <path d="M9 8h6M9 12h6M9 16h3" />
          </svg>
          <span className="text-[14px] font-semibold" style={{ color: '#13294B' }}>Show receipt</span>
        </span>
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#B6C1CD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden>
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>

      {open && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute inset-0 flex flex-col justify-end md:items-center md:justify-center md:p-6">
            <div className="relative bg-white w-full md:max-w-sm rounded-t-[22px] md:rounded-[22px] px-[22px] pt-[10px] pb-[26px]">
              <div className="mx-auto mb-[18px] h-1 w-9 rounded-full" style={{ background: '#E2E8EE' }} aria-hidden />

              <span
                className="inline-block rounded-full px-2.5 py-1 text-[11px] font-medium"
                style={{
                  background: isPaidInFull ? '#E7F6EC' : '#EAF1FB',
                  color:      isPaidInFull ? '#1E7A45' : '#2B5FA8',
                }}
              >
                {isPaidInFull ? 'Paid in full' : 'Open'}
              </span>

              <p className="mt-[14px] text-[19px] font-bold" style={{ color: '#13294B' }}>{practiceName}</p>

              <p className="mt-[16px] text-[11px] font-semibold uppercase" style={{ letterSpacing: '.14em', color: '#8496AA' }}>
                Plan total
              </p>
              <p className="mt-[4px] text-[30px] font-bold tabular-nums" style={{ color: '#13294B' }}>
                {formatRand(amount)}
              </p>

              <p className="mt-[18px] text-[13px]" style={{ color: '#8496AA' }}>
                Started {formatDate(createdDate)}
              </p>
              {refSegments.length > 0 && (
                <p className="mt-[3px] text-[13px]" style={{ color: '#8496AA' }}>{refSegments.join(' · ')}</p>
              )}

              <button
                type="button"
                onClick={() => setOpen(false)}
                className="mt-[22px] w-full rounded-[14px] py-[13px] text-[14.5px] font-semibold text-white"
                style={{ background: '#13294B' }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
