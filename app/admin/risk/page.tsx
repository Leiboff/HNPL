import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { formatDateTime, timeAgo } from '../_lib/format';
import { RiskReviewRow, KillSwitchRow } from './RiskControls';

// ─── /admin/risk — the review queue and the kill switches ──────────────────
//
// The audit's S-07 asks for manual-review states and platform kill switches.
// Migration 0142 provides both as data; this is where a human reaches them.
//
// A held customer with nowhere to be un-held is not a review state, it is an
// outage with extra steps — so this page is not decoration on the control, it
// is the half of it that makes `review` a defensible decision at all. Without
// it the only honest options are allow and deny, and a credit product cannot
// ship with only those two.
//
// ─── WHAT A REVIEWER IS ACTUALLY LOOKING AT ────────────────────────────────
//
// Rule names and numbers, never correlation tokens. The tokens are keyed
// HMACs (lib/risk/tokens.ts) and rendering them would put the correlation
// graph on a screen and into a screenshot, which is exactly the
// re-identification surface the tokenisation exists to prevent.
//
// So the queue answers "what fired, how far over, how many times" and links
// to the customer or practice record for everything else. A reviewer who
// needs to know WHICH device goes to the account page, where they are
// already authorised to see it.

export const dynamic = 'force-dynamic';

type ReviewRow = {
  id:           string;
  event:        string;
  state:        string;
  account_id:   string | null;
  practice_id:  string | null;
  score:        number;
  hit_count:    number;
  opened_at:    string;
  last_hit_at:  string;
  reasons:      Array<Record<string, unknown>> | null;
};

type SwitchRow = {
  name:       string;
  engaged:    boolean;
  reason:     string | null;
  changed_at: string;
};

export default async function AdminRiskPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin/risk' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  // Read through the SESSION client, never service-role: 0142's SELECT
  // policies are is_platform_admin(), and letting RLS do the gating means
  // this page cannot become the one that leaks the queue to a demoted
  // account. Same rule the audit log page follows.
  const [{ data: reviewRows }, { data: switchRows }] = await Promise.all([
    supabase
      .from('risk_reviews')
      .select('id, event, state, account_id, practice_id, score, hit_count, opened_at, last_hit_at, reasons')
      .in('state', ['open', 'in_review'])
      // Worst first, not oldest first. Leaving a duplicate-identity review
      // for an hour costs a plan HNPL will never collect; leaving a
      // busy-practice review costs a mildly annoyed receptionist.
      .order('score',       { ascending: false })
      .order('last_hit_at', { ascending: false })
      .limit(100),
    supabase
      .from('risk_kill_switches')
      .select('name, engaged, reason, changed_at')
      .order('name'),
  ]);

  const reviews  = (reviewRows ?? []) as ReviewRow[];
  const switches = (switchRows ?? []) as SwitchRow[];
  const engaged  = switches.filter((s) => s.engaged);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-gray-900">Risk</h1>
        <p className="text-sm text-gray-600">
          Subjects the aggregate fraud controls have held for a human decision,
          worst first, and the platform-wide stop controls.
        </p>
      </header>

      {engaged.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4">
          <p className="text-sm font-semibold text-red-900">
            {engaged.length === 1
              ? '1 kill switch is engaged.'
              : `${engaged.length} kill switches are engaged.`}
          </p>
          <p className="mt-1 text-sm text-red-800">
            {engaged.map((s) => s.name).join(', ')} — customers on these paths are
            being refused right now.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Kill switches
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {switches.map((s) => (
            <KillSwitchRow
              key={s.name}
              name={s.name}
              engaged={s.engaged}
              reason={s.reason}
              changedAt={formatDateTime(s.changed_at)}
            />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Review queue
          </h2>
          <span className="text-sm text-gray-500">
            {reviews.length === 0 ? 'Nothing held' : `${reviews.length} open`}
          </span>
        </div>

        {reviews.length === 0 ? (
          <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-600">
            Nothing is held for review. This is the normal state — a queue that is
            never empty means a threshold is set wrong, and a queue that is never
            populated means the controls are not reaching anything.
          </p>
        ) : (
          <ul className="space-y-3">
            {reviews.map((r) => (
              <li key={r.id}>
                <RiskReviewRow
                  reviewId={r.id}
                  event={r.event}
                  state={r.state}
                  score={r.score}
                  hitCount={r.hit_count}
                  openedAt={timeAgo(r.opened_at)}
                  lastHitAt={timeAgo(r.last_hit_at)}
                  reasons={r.reasons ?? []}
                  subjectHref={
                    r.account_id
                      ? `/admin/customers/${r.account_id}`
                      : r.practice_id
                        ? `/admin/practices/${r.practice_id}`
                        : null
                  }
                  subjectLabel={r.account_id ? 'Customer' : r.practice_id ? 'Practice' : 'Unattached'}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-sm text-gray-500">
        Thresholds live in <code>lib/risk/policy.ts</code>; the runbook is{' '}
        <Link href="/admin/audit" className="underline">
          the privileged-action log
        </Link>{' '}
        plus <code>docs/FRAUD-RISK-OPERATIONS.md</code>.
      </p>
    </div>
  );
}
