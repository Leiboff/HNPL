import Link from 'next/link';

// ─── YourPlansCard ───────────────────────────────────────────────────
//
// Home-dashboard tile that shows the patient's ACTIVE plans as chips —
// one per plan (cap 3), each with practice name, "X of Y paid" caption,
// and a thin progress bar. Rows tap through to /patient/orders (the
// plans/orders detail surface — no dedicated per-plan page).
//
// Zero active plans → compact empty state with a Find-care link.
// Card header keeps "Your Plans" + total count so the patient's mental
// model ("I have N plans across all statuses") is preserved even when
// only ACTIVE plans render as chips.
//
// Server Component (display-only, no interactivity). The parent passes
// chips already sorted; ordering / progress math is in page.tsx.

export type PlanChipInput = {
  id:           string;
  practiceName: string;
  paid:         number;
  total:        number;
  percent:      number;
  isPaidInFull: boolean;
};

const CHIP_CAP = 3;

type Props = {
  activeCount: number;
  totalCount:  number;
  chips:       PlanChipInput[];
};

export default function YourPlansCard({ activeCount, totalCount, chips }: Props) {
  const overflow = Math.max(0, chips.length - CHIP_CAP);
  const visible  = chips.slice(0, CHIP_CAP);

  return (
    <section
      className="bg-white rounded-2xl shadow-sm border border-[rgba(19,41,75,.08)] p-5 sm:p-6"
      data-testid="your-plans-card"
    >
      <div className="flex items-center justify-between gap-3">
        <p
          className="text-xs font-semibold uppercase tracking-widest"
          style={{ color: '#13294B', opacity: 0.6 }}
        >
          Your Plans
        </p>
        {totalCount > 0 && (
          <p
            className="text-xs font-medium text-gray-500 tabular-nums"
            data-testid="dashboard-active-plans-count"
          >
            {activeCount} active
          </p>
        )}
      </div>

      {chips.length === 0 ? (
        totalCount === 0 ? (
          <div
            className="mt-3 rounded-xl border border-dashed border-gray-200 py-6 text-center"
            data-testid="your-plans-empty"
          >
            <p className="text-sm font-medium text-gray-500">No payment plans yet</p>
            <p className="mt-1 text-xs text-gray-400">Plans appear here when a practice sends you a bill.</p>
            <Link
              href="/patient/explore"
              className="mt-3 inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-semibold text-white"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              Find care →
            </Link>
          </div>
        ) : (
          <div className="mt-3 rounded-xl border border-dashed border-gray-200 py-6 text-center">
            <p className="text-sm text-gray-500">No active plans right now.</p>
            <Link
              href="/patient/orders"
              className="mt-2 inline-flex text-xs font-medium text-[#13294B] underline underline-offset-2"
            >
              See all {totalCount} →
            </Link>
          </div>
        )
      ) : (
        <>
          <ul className="mt-3 space-y-2" data-testid="your-plans-chips">
            {visible.map((c) => (
              <li key={c.id}>
                <Link
                  href="/patient/orders"
                  className="block rounded-xl border border-gray-100 hover:border-gray-200 hover:bg-gray-50 transition-colors px-3 py-2.5"
                  data-testid="your-plans-chip"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-gray-900 truncate min-w-0" style={{ color: '#13294B' }}>
                      {c.practiceName}
                    </p>
                    <p className="text-xs text-gray-500 tabular-nums shrink-0">
                      {c.isPaidInFull ? 'Paid in full' : `${c.paid} of ${c.total} paid`}
                    </p>
                  </div>
                  <div
                    className="mt-2 h-1.5 w-full rounded-full bg-gray-100 overflow-hidden"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={c.percent}
                    aria-label={`${c.practiceName}: ${c.percent}% paid`}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width:      `${c.percent}%`,
                        background: c.isPaidInFull
                          ? '#15A89E'
                          : 'linear-gradient(90deg, #13294B 0%, #15A89E 100%)',
                      }}
                    />
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {(overflow > 0 || totalCount > activeCount) && (
            <Link
              href="/patient/orders"
              className="mt-3 inline-flex items-center text-xs font-medium text-[#13294B] underline underline-offset-2 hover:opacity-80"
              data-testid="your-plans-view-all"
            >
              {overflow > 0
                ? `View all ${totalCount} →`
                : `See ${totalCount - activeCount} past plan${totalCount - activeCount === 1 ? '' : 's'} →`}
            </Link>
          )}
        </>
      )}
    </section>
  );
}
