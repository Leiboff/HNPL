'use client';

import { useState } from 'react';
import ReferralShareCard from './ReferralShareCard';
import ReferDoctorForm from './ReferDoctorForm';

// ─── Two buttons, because they are two different things ──────────────────
//
// Referring a friend and referring a doctor are the same IMPULSE — "someone I
// know should be part of this" — and completely different mechanics. This
// screen used to put them behind a tab strip, which quietly claimed they were
// two views of one thing and put a form on screen before anybody had said
// which kind of referral they were making.
//
// So: a choice, then the one thing that choice needs.
//
//   REFER A FRIEND   is the shareable link and nothing else. A friend signs
//                    themselves up, so the code carried into that signup is
//                    the entire mechanism — the share sheet, WhatsApp, email,
//                    the clipboard. There is no form on this side and no
//                    server action behind it: a friend referral is recorded
//                    by lib/referrals/claim.ts when the friend ARRIVES, not
//                    speculatively when the link is sent.
//
//   REFER A DOCTOR   is a lead form. A practice cannot sign itself up, there
//                    is no signup a code could be carried into, and a link
//                    handed to a receptionist leads nowhere useful. What this
//                    side produces is a crm_leads row with source='referral'
//                    for a rep to work, so it asks for what that rep will
//                    need: who to ask for, their specialty, a number, and
//                    where they are.
//
// Migration 0145 encodes the same asymmetry one layer down — the
// referrals_link_is_patient_only constraint refuses a practice referral with
// channel='link' — so a share affordance on the doctor side would be
// offering something the database would reject.
//
// ─── WHY BACK UNMOUNTS RATHER THAN HIDES ─────────────────────────────────
//
// ReferDoctorForm holds pending/error/done state plus seven fields and a
// picked Google place, none of which mean anything once somebody has gone
// back to the choice. Unmounting it is exactly the semantics wanted and
// cannot drift the way a hand-written reset can — the tabbed version of this
// screen cleared four pieces of state by hand and would have missed the
// fifth.

export type ReferMode = 'friend' | 'doctor';

const CHOICES: ReadonlyArray<{
  value: ReferMode;
  label: string;
  blurb: string;
  glyph: React.ReactNode;
}> = [
  {
    value: 'friend',
    label: 'Refer a friend',
    blurb: 'Send them your link. When they sign up with it, they show up below.',
    glyph: (
      <>
        <circle cx="9" cy="8.5" r="3.5" />
        <path d="M3.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5" />
        <path d="M17 7.5h4M19 5.5v4" />
      </>
    ),
  },
  {
    value: 'doctor',
    label: 'Refer a doctor',
    blurb: 'Tell us who they are and we’ll get in touch with their rooms.',
    glyph: (
      <>
        <path d="M6 3.5h12a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5Z" />
        <path d="M12 8.5v6M9 11.5h6" />
      </>
    ),
  },
];

export default function ReferChoice({ code }: { code: string | null }) {
  const [mode, setMode] = useState<ReferMode | null>(null);

  if (mode === null) {
    return (
      <div className="flex flex-col gap-[10px]" data-testid="refer-choice">
        {CHOICES.map(({ value, label, blurb, glyph }) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            data-testid={`refer-choose-${value}`}
            className="flex items-center gap-[14px] rounded-card bg-white p-[18px] text-left"
            style={{
              border: '1px solid rgba(19,41,75,.06)',
              boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)',
            }}
          >
            <span
              className="flex h-[42px] w-[42px] flex-none items-center justify-center rounded-tile"
              style={{ background: 'rgba(19,41,75,.05)', color: 'var(--portal-ink)' }}
            >
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                width={22}
                height={22}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {glyph}
              </svg>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold" style={{ color: 'var(--portal-ink)' }}>
                {label}
              </span>
              <span className="mt-1 block text-[12.5px] leading-[1.5]" style={{ color: 'var(--portal-muted)' }}>
                {blurb}
              </span>
            </span>
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              width={18}
              height={18}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="flex-none"
              style={{ color: 'rgba(19,41,75,.35)' }}
            >
              <path d="m9.5 5.5 7 6.5-7 6.5" />
            </svg>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[14px]">
      <button
        type="button"
        onClick={() => setMode(null)}
        data-testid="refer-back"
        className="flex items-center gap-1.5 self-start text-[13px] font-semibold"
        style={{ color: 'var(--portal-accent-ink)' }}
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          width={16}
          height={16}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m14 5.5-7 6.5 7 6.5" />
        </svg>
        Back
      </button>

      {mode === 'friend'
        // No code means ensureMyReferralCode failed; the page says so in its
        // own notice above rather than this card rendering channels that link
        // nowhere. There is nothing else on the friend side to fall back to,
        // which is why that notice is worded the way it is.
        ? (code && <ReferralShareCard code={code} />)
        : <ReferDoctorForm />}
    </div>
  );
}
