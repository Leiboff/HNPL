'use client';

// ─── PlanPickerCards — pay-in-2 vs pay-in-3 as branded cards ───────────
//
// Presentation-only restyle of the existing Step 2 radio buttons. The
// caller still owns:
//   • totalAmount (bill total from the SECURITY DEFINER RPC; we render
//     it, never recompute it)
//   • planType + setPlanType (the only state this component drives)
//   • the salary-day picker + ScheduleStrip below (kept verbatim by
//     CheckoutForm)
//
// Per-instalment numbers come from `instalmentForPlan` — a thin
// passthrough to the EXISTING previewInstalments() that already lives
// in CheckoutForm. We accept it as a prop so this component is the
// sole owner of the visual decisions but DOES NOT duplicate the cents-
// distribution arithmetic. No second source of truth for amounts.
//
// Honest cadence copy
// ────────────────────
// BetterNow's collection model uses the patient's salary days — the
// FIRST payment is taken on accept (today), the next on the next
// salary day ≥ 5 days out, the third (for plan-3) on the salary day
// the month after that. So "2 payments on your salary dates" /
// "3 payments on your salary dates" is the truthful copy. Do NOT say
// "/month" — that conflates BetterNow with PayZen's monthly model and
// would be misleading on a 28-day or near-month-boundary plan.
//
// "No interest or fees" — load-bearing
// ─────────────────────────────────────
// Featured prominently on every card. This is BetterNow's legal +
// trust posture: zero interest, zero fees, the patient pays only the
// bill total split into N payments. The chip is visually distinct
// (teal) and present unconditionally — never gated on plan or amount.
//
// Branding + tone
// ────────────────
// Navy (#13294B) and teal (#15A89E); the rounded-2xl card chrome the
// rest of the checkout uses; generous whitespace; per-payment hero
// number large enough to be the first thing a patient reads. No
// urgency / scarcity / countdown — this is healthcare financing, not
// a payday lender.
//
// Mobile-first
// ─────────────
// Full-width cards STACKED vertically at every breakpoint (single
// column — never side-by-side), so the eye reads top-to-bottom and the
// pre-selected default is unmistakably first. Tap targets are the full
// card surface. The smaller-instalment 3-payment option is rendered
// FIRST/on top (see PLAN_OPTIONS order) and is the caller's default.

type Props = {
  totalAmount:        number;
  planType:           2 | 3;
  setPlanType:        (n: 2 | 3) => void;
  /**
   * Per-instalment amount for the given plan size. Caller passes the
   * existing previewInstalments-derived function so this component
   * never reimplements the split.
   */
  perInstalmentAmount: (n: 2 | 3) => number;
};

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

// 3-payment (smaller instalment) FIRST/on top — it's the default and
// the eye should land on it. 2-payment second.
const PLAN_OPTIONS = [3, 2] as const;

export default function PlanPickerCards({
  totalAmount,
  planType,
  setPlanType,
  perInstalmentAmount,
}: Props) {
  return (
    <section className="space-y-3">
      {/* Calm, agency-giving framing — not "here's what you owe". */}
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-[#0F1F3A]">Choose the option that works for you</h2>
        <p className="text-sm text-[#3A4B66]">
          Both options are interest-free. Pick how many salary dates you&apos;d like to spread your bill across.
        </p>
      </header>

      <div role="radiogroup" aria-label="Number of instalments" className="grid grid-cols-1 gap-3">
        {PLAN_OPTIONS.map((n) => {
          const each   = perInstalmentAmount(n);
          const active = planType === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPlanType(n)}
              data-testid={`plan-card-${n}`}
              data-active={active ? 'true' : 'false'}
              className={[
                'group relative w-full text-left rounded-2xl border-2 p-5 transition-all',
                'focus:outline-none focus-visible:ring-4 focus-visible:ring-[#15A89E]/20',
                active
                  ? 'border-[#15A89E] bg-[#15A89E]/6 shadow-[0_2px_10px_rgba(21,168,158,0.10)]'
                  : 'border-[#E5E9F0] bg-white hover:border-[#D8DEE8]',
              ].join(' ')}
            >
              {/* Selected checkmark — top-right, only when active. */}
              {active && (
                <span
                  aria-hidden
                  className="absolute top-3 right-3 inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#15A89E] text-white"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                    <path d="m5 12.5 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              )}

              {/* Term badge — small, navy-on-teal-tint pill above the hero. */}
              <span
                className={[
                  'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em]',
                  active
                    ? 'bg-[#13294B] text-white'
                    : 'bg-[#13294B]/5 text-[#13294B]',
                ].join(' ')}
              >
                {n} payments
              </span>

              {/* HERO — per-instalment amount. Biggest number on the card. */}
              <p className="mt-3 text-4xl font-semibold tabular-nums text-[#13294B]">
                {formatRand(each)}
              </p>
              <p className="text-sm text-[#3A4B66] mt-0.5">
                {/* Honest cadence — salary dates, NOT "/month". */}
                × {n} payments on your salary dates
              </p>

              {/* "No interest or fees" — load-bearing trust signal. */}
              <p
                className={[
                  'mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
                  active
                    ? 'bg-white text-[#15A89E] ring-1 ring-[#15A89E]/30'
                    : 'bg-[#15A89E]/8 text-[#0A6F68]',
                ].join(' ')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <circle cx="12" cy="12" r="9" />
                  <path d="m8 12.5 2.5 2.5L16 9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                No interest or fees
              </p>

              {/* Total — secondary / de-emphasised. Honest, not the hero. */}
              <p className="mt-3 text-xs text-[#7A8AA0]">
                Total:&nbsp;
                <span className="tabular-nums font-medium text-[#3A4B66]">{formatRand(totalAmount)}</span>
              </p>
            </button>
          );
        })}
      </div>
    </section>
  );
}
