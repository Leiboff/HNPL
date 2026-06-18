// ─── Checkout chrome — shared layout primitives ─────────────────────────
//
// Three lightweight building blocks the steps in CheckoutForm and the
// /done page compose. Kept in one file because they're tightly coupled:
//
//   • BillChip       — the one-line condensed bill summary that runs
//                      at the top of every step (replacing the heavy
//                      BillSummary card that used to claim ~30% of
//                      mobile viewport on every screen).
//   • ScheduleStrip  — the calendar-strip schedule preview, used on
//                      the Plan + Pay steps. Substance — every date,
//                      every amount — rendered as a connected row of
//                      date-pegs rather than a spreadsheet table.
//   • StepShell      — the consistent step card (medallion + heading
//                      slot + body slot + actions slot). Makes the
//                      "one thing per screen" rhythm explicit.

import type { ReactNode } from 'react';
import StepMedallion, { type StepIconKind } from './StepMedallion';

// ─── formatters (kept local — checkout has its own already) ─────────────
function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

// ─── BillChip ────────────────────────────────────────────────────────────
//
// A single horizontal pill running across the top of every checkout
// step. The full breakdown sits on the Plan + Pay steps; this is the
// "you're on screen 2 of 4, here's what we're still talking about"
// reassurance.

export function BillChip({
  practiceName,
  totalAmount,
}: {
  practiceName: string;
  totalAmount:  number;
}) {
  return (
    <div className="rounded-full border border-[#E5E9F0] bg-white px-4 py-2 flex items-center gap-2.5 text-sm shadow-[0_1px_2px_rgba(15,31,58,0.04)]">
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#13294B]/8 text-[#13294B]">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
          <path d="M6 3.5h12v17l-2.5-1.8-2 1.5-2-1.5-2 1.5-2-1.5L6 20.5v-17Z" />
        </svg>
      </span>
      <span className="truncate text-[#3A4B66]">
        Bill from <span className="font-medium text-[#0F1F3A]">{practiceName}</span>
      </span>
      <span className="ml-auto font-semibold tabular-nums text-[#0F1F3A]">
        {formatRand(totalAmount)}
      </span>
    </div>
  );
}

// ─── ScheduleStrip ───────────────────────────────────────────────────────
//
// Calendar-strip schedule preview: each instalment is a "peg" on a
// connected horizontal line. Substance kept (every date, every amount
// rendered) but it reads as a payment plan rather than a table.
//
// The first peg shows "Today" not the date — that's the moment the
// patient is committing to, and "Today" reads warmer than the literal
// date.

export function ScheduleStrip({
  instalments,
  dates,
}: {
  instalments: number[];
  dates:       Date[];
}) {
  return (
    <div className="rounded-2xl border border-[#E5E9F0] bg-[#FAFBFD] p-4 sm:p-5">
      <p className="text-xs uppercase tracking-[0.08em] font-medium text-[#7A8AA0] mb-3.5">
        Your schedule
      </p>
      <div className="relative">
        {/* Connecting line behind the dots */}
        <div
          aria-hidden
          className="absolute top-[7px] left-[6%] right-[6%] h-px bg-[#D8DEE8]"
        />
        <ol className="relative grid" style={{ gridTemplateColumns: `repeat(${instalments.length}, minmax(0, 1fr))` }}>
          {instalments.map((amount, i) => (
            <li key={i} className="flex flex-col items-center text-center">
              <span
                className={`relative z-10 inline-block h-3.5 w-3.5 rounded-full border-2 ${
                  i === 0
                    ? 'border-[#15A89E] bg-[#15A89E]'
                    : 'border-[#13294B]/30 bg-white'
                }`}
                aria-hidden
              />
              <span className="mt-2.5 text-xs font-medium text-[#3A4B66]">
                {i === 0 ? 'Today' : formatDate(dates[i])}
              </span>
              <span className="mt-1 text-[15px] font-semibold tabular-nums text-[#0F1F3A]">
                {formatRand(amount)}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// ─── StepShell ───────────────────────────────────────────────────────────
//
// Standard step card: medallion in a soft brand halo, a single big
// conversational heading, optional one-line subtitle, body slot, then
// the actions slot at the bottom. The rhythm is identical across all
// four checkout steps + the /done password screen so the patient feels
// the flow as one thing, not five disjoint forms.

export function StepShell({
  icon,
  iconTone = 'brand',
  heading,
  subhead,
  children,
  actions,
}: {
  icon:      StepIconKind;
  iconTone?: 'brand' | 'teal' | 'navy' | 'green';
  heading:   string;
  subhead?:  string;
  children:  ReactNode;
  actions:   ReactNode;
}) {
  return (
    <section className="rounded-[20px] border border-[#E5E9F0] bg-white p-6 sm:p-8 shadow-[0_1px_2px_rgba(15,31,58,0.04)]">
      <div className="flex items-center gap-4 mb-6">
        <StepMedallion icon={icon} tone={iconTone} />
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-[28px] leading-tight tracking-[-0.01em] font-semibold text-[#0F1F3A]">
            {heading}
          </h1>
          {subhead && (
            <p className="mt-1 text-[15px] leading-relaxed text-[#3A4B66]">{subhead}</p>
          )}
        </div>
      </div>

      <div className="space-y-6">
        {children}
      </div>

      <div className="mt-7">
        {actions}
      </div>
    </section>
  );
}

// ─── Primary + secondary action buttons ─────────────────────────────────
//
// One styled primary per screen — keeps the "single clear action" rule
// honest. Secondary action (Back) stays a quiet text-like button so it
// never competes for attention.

export function PrimaryButton({
  children,
  onClick,
  type = 'button',
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?:    'button' | 'submit';
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-xl px-5 py-3.5 text-base font-semibold text-white focus:outline-none focus-visible:ring-4 focus-visible:ring-[#15A89E]/30 transition-shadow disabled:opacity-60 disabled:cursor-not-allowed hover:shadow-[0_8px_20px_-8px_rgba(21,168,158,0.55)]"
      style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 140%)' }}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-sm font-medium text-[#3A4B66] hover:text-[#13294B] focus:outline-none focus-visible:underline disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  );
}
