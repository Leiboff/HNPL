import StatusChip from '@/components/StatusChip';
import {
  displayReferralStatus,
  REFERRAL_STATUS_LABEL,
  type ReferralStatus,
} from '@/lib/referrals/vocabulary';

// ─── What the patient has referred so far ────────────────────────────────
//
// Presentational, a plain server component. Every row it renders came from
// the referrer's own RLS-scoped read (0145's referrals_referrer_select), so
// there is nothing here that filters by owner — the database already did, and
// a second filter in the view would suggest it had not.
//
// ─── WHAT A STATUS IS ALLOWED TO SAY ─────────────────────────────────────
//
// Four words, and none of them is a promise. 'Joined' means an account was
// created and attributed; it does NOT say whether that person has a bill, a
// plan, or a payment, because none of that is the referrer's business. That
// restraint is a privacy decision, not a copywriting one: the referrer knows
// this person, so anything shown here is something they learn about a friend.
//
// There is no reward column, because there is no incentive programme. See
// docs/REFERRALS.md.

export type ReferralRow = {
  id:            string;
  kind:          string;
  status:        string;
  invitee_name:  string | null;
  invitee_email: string | null;
  practice_name: string | null;
  expires_at:    string | null;
  created_at:    string;
};

const CHIP: Record<ReferralStatus, string> = {
  pending:   'bg-amber-50 text-amber-700',
  signed_up: 'bg-sky-50 text-sky-700',
  converted: 'bg-emerald-50 text-emerald-700',
  expired:   'bg-gray-100 text-gray-600',
  void:      'bg-gray-100 text-gray-600',
};

/**
 * What to call a referral whose invitee details have been scrubbed.
 *
 * prune_referral_invites() nulls the contact columns on dead invitations
 * (POPIA — see 0145), so an old row genuinely has no name to show. That is
 * the system working, and the label says so rather than rendering a blank
 * line or, worse, the string "null".
 */
function title(row: ReferralRow): string {
  if (row.kind === 'practice') return row.practice_name ?? 'A practice';
  return row.invitee_name || row.invitee_email || 'Someone you invited';
}

export default function ReferralList({ rows }: { rows: ReferralRow[] }) {
  if (rows.length === 0) {
    return (
      <section
        className="rounded-card bg-white p-[18px]"
        style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        data-testid="referral-list-empty"
      >
        <p className="text-[14px] font-semibold" style={{ color: 'var(--portal-ink)' }}>
          No referrals yet
        </p>
        <p className="mt-1.5 text-[13px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>
          Anyone who joins through your link or code will appear here.
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded-card bg-white overflow-hidden"
      style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
      data-testid="referral-list"
    >
      <p
        className="px-[18px] pt-4 pb-3 text-[11px] font-semibold uppercase"
        style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.45)' }}
      >
        Your referrals
      </p>
      <ul className="border-t border-gray-100 divide-y divide-gray-100">
        {rows.map((row) => {
          const status = displayReferralStatus(row) as ReferralStatus;
          return (
            <li key={row.id} className="flex items-center gap-3 px-[18px] py-[14px]">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold" style={{ color: 'var(--portal-ink)' }}>
                  {title(row)}
                </p>
                <p className="text-[12.5px]" style={{ color: 'var(--portal-muted)' }}>
                  {row.kind === 'practice' ? 'Practice' : 'Friend'}
                </p>
              </div>
              <StatusChip
                label={REFERRAL_STATUS_LABEL[status] ?? status}
                cls={CHIP[status] ?? CHIP.pending}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
