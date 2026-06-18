// ─── StepMedallion ───────────────────────────────────────────────────────
//
// The visual "anchor" for each checkout step: a 56-px soft-gradient
// halo containing a single line icon. The medallion does the work of
// saying what the screen is about BEFORE the words do — which is the
// biggest lever from "form" to "guided flow".
//
// Icons are hand-inlined SVG (no new dep), 24×24, strokeWidth 1.5 for
// a light, drawn feel. Stroke colour inherits from `currentColor` so a
// future theme tweak only touches the wrapper.
//
// Restrained on purpose: one medallion per step, no animation. The
// brand reads as trustworthy/medical, not playful.

import type { ReactNode } from 'react';

export type StepIconKind =
  | 'bill'         // Step 1 — bill review (receipt with R sign)
  | 'calendar'     // Step 2 — plan + schedule (calendar with dots)
  | 'idcard'       // Step 3 — patient details (id card with header line)
  | 'card'         // Step 4 — pay (credit card with chip)
  | 'shield'       // /done password (shield with check)
  | 'check'        // /done top success (check in circle)
  | 'clock'        // Waiting panel — waiting/viewing
  | 'tick';        // Waiting panel — paid

const ICONS: Record<StepIconKind, ReactNode> = {
  // Receipt-like outline with a clean R for ZAR. Light stroke, no
  // visual noise — the medallion does the colour-coding.
  bill: (
    <>
      <path d="M6 3.5h12v17l-2.5-1.8-2 1.5-2-1.5-2 1.5-2-1.5L6 20.5v-17Z" />
      <path d="M9 9h2.5a1.75 1.75 0 0 1 0 3.5H9V9Zm0 3.5h1.5l2 3" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Calendar with three dots (representing 2-3 instalment markers).
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" strokeLinecap="round" />
      <circle cx="8" cy="14" r="1" />
      <circle cx="12" cy="14" r="1" />
      <circle cx="16" cy="14" r="1" />
    </>
  ),
  // ID card with photo box + lines. Soft, professional.
  idcard: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <circle cx="8.5" cy="11.5" r="2" />
      <path d="M14 10.5h4M14 13h4M5.5 16.5h13" strokeLinecap="round" />
    </>
  ),
  // Credit card with chip detail.
  card: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10.5h18" />
      <rect x="6" y="13.5" width="3.5" height="2.5" rx="0.5" />
    </>
  ),
  // Shield with internal check. The "your account is safe" cue.
  shield: (
    <>
      <path d="M12 3.5 4.5 6v6.5c0 4.2 3.1 7.4 7.5 8.5 4.4-1.1 7.5-4.3 7.5-8.5V6L12 3.5Z" />
      <path d="m9 12.25 2.25 2.25L15.25 10.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Big check inside a circle — clean success cue.
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.25 2.75 2.75L16.5 9" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Clock — used while waiting/viewing on the practice-side panel.
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 1.75" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Bold check — paid moment. Uses thicker stroke for emphasis.
  tick: (
    <>
      <path d="m5 12.5 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

type Props = {
  icon:      StepIconKind;
  // The tone defaults to "brand" — a navy→teal gradient halo. The
  // waiting panel overrides this to colour-code its three states.
  tone?:     'brand' | 'teal' | 'navy' | 'green' | 'amber' | 'muted';
  /** When false, render at the medallion's "header" size (56px). */
  size?:     'header' | 'inline';
};

const TONE_STYLE: Record<NonNullable<Props['tone']>, { bg: string; ring: string; ink: string }> = {
  brand: {
    bg:   'bg-[radial-gradient(circle_at_30%_25%,#15A89E22,#13294B14_70%)]',
    ring: 'ring-1 ring-[#13294B]/10',
    ink:  'text-[#13294B]',
  },
  teal: {
    bg:   'bg-[#15A89E]/10',
    ring: 'ring-1 ring-[#15A89E]/25',
    ink:  'text-[#0E7C73]',
  },
  navy: {
    bg:   'bg-[#13294B]/8',
    ring: 'ring-1 ring-[#13294B]/15',
    ink:  'text-[#13294B]',
  },
  green: {
    bg:   'bg-[#E7F6EC]',
    ring: 'ring-1 ring-[#1E9E55]/20',
    ink:  'text-[#1E7A45]',
  },
  amber: {
    bg:   'bg-[#FBF1DD]',
    ring: 'ring-1 ring-[#C8841C]/20',
    ink:  'text-[#8A5A11]',
  },
  muted: {
    bg:   'bg-[#EEF1F6]',
    ring: 'ring-1 ring-[#7A8AA0]/20',
    ink:  'text-[#7A8AA0]',
  },
};

export default function StepMedallion({ icon, tone = 'brand', size = 'header' }: Props) {
  const t = TONE_STYLE[tone];
  const dim = size === 'header' ? 'w-14 h-14' : 'w-10 h-10';
  // `tick` icon uses a slightly bolder stroke for the final paid moment.
  const stroke = icon === 'tick' ? 2 : 1.5;
  return (
    <div className={`${dim} rounded-full flex items-center justify-center ${t.bg} ${t.ring}`}>
      <svg
        width={size === 'header' ? 26 : 22}
        height={size === 'header' ? 26 : 22}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        aria-hidden
        className={t.ink}
      >
        {ICONS[icon]}
      </svg>
    </div>
  );
}
