// ─── Approved balance card — display-only, null-guarded ───────────────
//
// Render contract:
//   • Renders NOTHING when `limit === null`. No placeholder, no
//     "R0 available" — the widget's mere presence tells the patient
//     they have an approved limit; absence = no limit set.
//   • Shows all THREE figures together: the full approved limit, what is
//     available, and what active plans are holding.
//
// ─── THE FULL LIMIT IS ALWAYS SHOWN ────────────────────────────────────
//
// Including for a first-time patient who may only hold one plan at a
// time. The temptation is to show them a reduced number so the concurrency
// rule cannot surprise them — but that hides what they actually qualified
// for and makes the figure they were told at sign-up disagree with the
// figure on their dashboard. Instead the real limit is shown with the
// caveat spelled out beneath it.
//
// This is a server component (no interactivity). No client-side state, no
// client writes — the limit is service-role only (0122 column allow-list).

import TestBalanceNotice from './TestBalanceNotice';

type Props = {
  /** Patient's approved credit limit — NULL when no limit set. */
  limit:       number | null;
  /** Available headroom (rands). Ignored when limit is null. */
  available:   number;
  /** What live plans are holding against the limit (rands). */
  committed:   number;
  /**
   * True when this limit came from a real assessment
   * (profiles.current_credit_assessment_id is set). False for limits
   * granted by the pre-launch stub, which still need the test notice.
   */
  assessed:    boolean;
  /**
   * True when the patient has never completed a plan, and so may hold only
   * one at a time regardless of headroom.
   */
  firstTimer:  boolean;
};

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

export default function ApprovedBalanceCard({
  limit, available, committed, assessed, firstTimer,
}: Props) {
  // The null-guard IS the "no placeholder" rule. This component exists as
  // a component (rather than the page inlining the JSX) partly so this
  // early-return can't be forgotten.
  if (limit == null) return null;

  return (
    <div className="flex flex-col gap-3">
      <div
        className="rounded-2xl shadow-sm border border-[rgba(19,41,75,.08)] p-5 sm:p-6"
        style={{
          background: 'linear-gradient(135deg, var(--brand-navy-deep) 0%, var(--brand-navy) 60%, var(--portal-accent) 145%)',
          color:      '#ffffff',
        }}
        data-testid="approved-balance-card"
      >
        <p className="text-xs font-semibold uppercase tracking-widest opacity-80">
          Approved balance
        </p>
        <p className="mt-3 text-4xl sm:text-5xl font-bold tabular-nums" data-testid="approved-balance-available">
          {formatRand(available)}
        </p>
        <p className="mt-1 text-sm opacity-80">
          available of {formatRand(limit)} approved
        </p>

        {committed > 0 && (
          <p className="mt-3 text-[13px] opacity-75" data-testid="approved-balance-committed">
            {formatRand(committed)} is committed to plans you&rsquo;re currently paying.
            It frees up when a plan is fully paid off.
          </p>
        )}

        {firstTimer && (
          // Stated plainly rather than by quietly reducing the figure
          // above. For a first-timer this rule almost always binds before
          // headroom does, so it is the more useful thing to know.
          <p className="mt-3 text-[13px] opacity-75" data-testid="approved-balance-first-timer">
            While this is your first plan, you can hold one plan at a time.
            Once it&rsquo;s paid off you can have more than one running together.
          </p>
        )}
      </div>

      {/* Only for limits that predate real underwriting. See the notice. */}
      {!assessed && <TestBalanceNotice />}
    </div>
  );
}
