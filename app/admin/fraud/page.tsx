import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { formatDateTime, timeAgo, fullName } from '../_lib/format';
import ReleaseForm from './ReleaseForm';

// ─── /admin/fraud — the decisions the identity rules made ─────────────────
//
// The rules in lib/security/identitySignals.ts can refuse a customer at the
// credit step. That refusal has to be visible to a person, by name, without
// reading application logs — otherwise "why was I declined" becomes a
// question nobody at this company can answer, which under the NCA is a worse
// problem than the fraud.
//
// Two kinds of row, and the FLAG rows are the more useful ones day to day:
//
//   flag   nobody was impeded. This is the queue that tells you whether the
//          thresholds are anywhere near right. There is no baseline for this
//          product — zero completed transactions — so the flag rate over the
//          first weeks is the only evidence for where the block line
//          actually belongs, and every threshold is env-tunable without a
//          deploy precisely so that evidence can be acted on.
//   block  somebody was refused. Each of these is a person who could not get
//          treatment financed, so the default posture on this page is to
//          look at every one.
//
// Read through the SESSION client, never service-role: 0138's SELECT policy
// is is_platform_admin(), and letting RLS do the gating means this page
// cannot become the one that leaks the link graph to a demoted account.

export const dynamic = 'force-dynamic';

type PersonRef = { first_name: string; last_name: string; email: string };

type Row = {
  id:           string;
  user_id:      string | null;
  surface:      string;
  decision:     string;
  rule:         string | null;
  detail:       { counts?: Record<string, number> } | null;
  created_at:   string;
  released_at:  string | null;
  release_note: string | null;
  subject:      PersonRef | PersonRef[] | null;
  releaser:     PersonRef | PersonRef[] | null;
};

const PAGE_SIZE = 100;

/** "device_shared_by_6_accounts" → "Device shared by 6 accounts". */
function humanRule(rule: string | null): string {
  if (!rule) return 'No rule recorded';
  const words = rule.replace(/^released:/, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const SURFACE_LABEL: Record<string, string> = {
  signup:       'at sign-up',
  credit_claim: 'at the credit step',
  card_add:     'when adding a card',
};

export default async function AdminFraudPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin/fraud' });

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

  const sp   = await searchParams;
  const chip = typeof sp.chip === 'string' ? sp.chip : 'open';

  let query = supabase
    .from('fraud_decisions')
    .select(`
      id, user_id, surface, decision, rule, detail, created_at,
      released_at, release_note,
      subject:profiles!fraud_decisions_user_id_fkey(first_name, last_name, email),
      releaser:profiles!fraud_decisions_released_by_fkey(first_name, last_name, email)
    `)
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);

  if (chip === 'open')     query = query.is('released_at', null);
  if (chip === 'blocks')   query = query.eq('decision', 'block');
  if (chip === 'released') query = query.not('released_at', 'is', null);

  const { data: rawRows } = await query;
  const rows = (rawRows ?? []) as unknown as Row[];

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-gray-900">Identity flags</h1>
        <p className="text-sm text-gray-600">
          Accounts the linking rules found sharing a device, card, phone or network
          with other accounts. A <strong>flag</strong> impedes nobody and is here so the
          thresholds can be judged; a <strong>block</strong> stopped someone at the credit
          step and should be looked at.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2">
        {[
          { key: 'open',     label: 'Open' },
          { key: 'blocks',   label: 'Blocks only' },
          { key: 'released', label: 'Released' },
          { key: 'all',      label: 'Everything' },
        ].map(({ key, label }) => (
          <Link
            key={key}
            href={`/admin/fraud?chip=${key}`}
            className={[
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              chip === key
                ? 'border-[#13294B] bg-[#13294B] text-white'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50',
            ].join(' ')}
          >
            {label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-500">
          Nothing here. On a platform this size that is the expected reading — the
          rules only speak when accounts actually share something.
        </p>
      ) : (
        <ol className="space-y-2">
          {rows.map((row) => {
            const blocked  = row.decision === 'block';
            const released = Boolean(row.released_at);
            const counts   = row.detail?.counts ?? {};

            return (
              <li
                key={row.id}
                className={[
                  'rounded-xl border p-3',
                  released ? 'border-gray-200 bg-white'
                    : blocked ? 'border-red-200 bg-red-50'
                    : 'border-amber-200 bg-amber-50',
                ].join(' ')}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-gray-900">
                    {blocked ? 'Blocked' : 'Flagged'} {SURFACE_LABEL[row.surface] ?? row.surface}
                    {' — '}{humanRule(row.rule)}
                  </span>
                  <span className="text-xs text-gray-500" title={row.created_at}>
                    {timeAgo(row.created_at)} · {formatDateTime(row.created_at)}
                  </span>
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-700">
                  {row.user_id ? (
                    <Link
                      href={`/admin/customers/${row.user_id}`}
                      className="font-medium text-[#13294B] underline"
                    >
                      {fullName(row.subject) || 'this customer'}
                    </Link>
                  ) : (
                    <span>account since deleted</span>
                  )}

                  {/* Every count, not just the one that fired. A block on a
                      card with three other quiet signals reads very
                      differently from a block on a card with nothing else —
                      the first is a ring, the second is usually a family. */}
                  {Object.entries(counts).map(([kind, n]) => (
                    <span key={kind} className="rounded bg-white/70 px-1.5 py-0.5 tabular-nums">
                      {kind}: shared with {n}
                    </span>
                  ))}
                </div>

                {released ? (
                  <p className="mt-2 text-xs text-gray-600">
                    Released by {fullName(row.releaser) || 'an admin'} ·{' '}
                    {formatDateTime(row.released_at!)} — “{row.release_note}”
                  </p>
                ) : blocked ? (
                  <ReleaseForm decisionId={row.id} />
                ) : (
                  // Flags are not released. Nothing was withheld, so there is
                  // nothing to give back — releasing one would only hide a
                  // data point the thresholds are being judged on.
                  <p className="mt-2 text-xs text-gray-500">
                    Nobody was impeded — this is recorded for the threshold review.
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
