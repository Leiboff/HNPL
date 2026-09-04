// ─── Approved balance card — display-only, null-guarded ───────────────
//
// Render contract (per the brief):
//   • Renders NOTHING when `limit === null`. No placeholder, no
//     "R0 available" — the widget's mere presence tells the patient
//     they have an approved limit; absence = no limit set.
//   • Renders `Approved balance · R X available` when limit is set,
//     with X = max(0, limit - outstanding_on_active_plans).
//
// This is a server component (no interactivity). The patient dashboard
// server-renders it into the page. No client-side state, no client
// writes — the limit is written only by runCreditCheck, from the
// affordability policy (0065 column-lock).
//
// ─── THE TEST-BALANCE NOTICE IS GONE, WITH THE STUB ────────────────────
//
// This card used to render a permanent red "Test balance — not real credit"
// banner, because the amount came from an unconditional R5,000 stub that
// performed no assessment. Both are removed: the only thing that can set a
// limit now is the real credit check (lib/underwriting/affordabilityPolicy),
// and a card that told a real customer their real limit was "for testing
// only" would be worse than no card at all.
//
// The null-guard below is what covers the interim. Until the credit check is
// live no limit exists, so this renders nothing rather than a zero.

type Props = {
  /** Patient's approved credit limit — NULL when no limit set. */
  limit:       number | null;
  /** Computed available balance (rands). Ignored when limit is null. */
  available:   number;
};

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

export default function ApprovedBalanceCard({ limit, available }: Props) {
  // The null-guard IS the "no placeholder" rule. This component
  // exists as a component (rather than the page inlining the JSX)
  // partly so this early-return can't be forgotten.
  if (limit == null) return null;

  return (
    <div className="flex flex-col gap-3">
      <div
        className="rounded-2xl shadow-sm border border-[rgba(19,41,75,.08)] p-5 sm:p-6"
        style={{
          // The two navies are now the SAME pair, in the same order, as the auth
          // screens' ground (AuthSurface's NAVY_GROUND) — the mid-stop was a
          // literal #1B3A6C, a fourth navy invented for this one card.
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
      </div>
    </div>
  );
}
