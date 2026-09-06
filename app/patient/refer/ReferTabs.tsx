'use client';

import { useState } from 'react';
import ReferralShareCard from './ReferralShareCard';
import ReferForm from './ReferForm';

// ─── The one choice this screen asks, and what hangs off it ──────────────
//
// A friend and a practice are the same ACT — "someone I know should be on
// this" — and two completely different mechanics. The toggle is what keeps
// the screen honest about that:
//
//   A friend    is SHAREABLE. There is a code, a link, and a share sheet,
//               because the person on the other end signs themselves up and
//               the code is what ties them back to the referrer. The email
//               form is one channel among several, not the only door.
//
//   A practice  is NOT shareable, and this is the reason the toggle owns the
//               share card rather than the page doing. A practice does not
//               self-serve: there is no signup a code could be carried into,
//               and a link handed to a receptionist leads nowhere useful.
//               What a practice referral produces is a LEAD — a crm_leads row
//               with source='referral' that a rep picks up and works. So on
//               this side the form is the whole feature, and no share
//               affordance is rendered at all.
//
// Migration 0145 encodes the same distinction one layer down: the
// `referrals_link_is_patient_only` constraint refuses a practice referral
// with channel='link', so a share card here would be offering something the
// database would reject.
//
// ─── STATE RESET IS A `key`, NOT A HANDLER ───────────────────────────────
//
// ReferForm holds pending/error/done state and a form full of inputs, none of
// which mean anything after a switch: a half-typed friend invitation is not a
// half-typed practice referral, and an error about an email address must not
// survive onto a screen that has a different email field on it.
//
// `key={mode}` makes React discard the instance and build a fresh one, which
// is exactly the semantics wanted and cannot drift the way a hand-written
// reset can — the earlier version of this cleared four pieces of state by
// hand and would have missed the fifth.

export type ReferMode = 'friend' | 'practice';

const TABS: ReadonlyArray<{ value: ReferMode; label: string }> = [
  { value: 'friend',   label: 'A friend' },
  { value: 'practice', label: 'A practice' },
];

export default function ReferTabs({ code }: { code: string | null }) {
  const [mode, setMode] = useState<ReferMode>('friend');

  return (
    <div className="flex flex-col gap-[14px]">
      <div
        role="tablist"
        aria-label="What are you referring?"
        className="flex gap-1 rounded-tile p-1"
        style={{ background: 'rgba(19,41,75,.05)' }}
      >
        {TABS.map(({ value, label }) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            data-testid={`refer-mode-${value}`}
            className="flex-1 rounded-tile py-[9px] text-[13.5px] font-semibold"
            style={mode === value
              ? { background: '#fff', color: 'var(--portal-ink)', boxShadow: '0 1px 3px rgba(15,31,58,.10)' }
              : { color: 'var(--portal-muted)' }}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'friend' && code && <ReferralShareCard code={code} />}

      <ReferForm key={mode} mode={mode} />
    </div>
  );
}
