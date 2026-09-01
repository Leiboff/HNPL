import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { formatDateTime, timeAgo, fullName } from '../_lib/format';

// ─── /admin/audit — the privileged-action log, where someone can see it ────
//
// A log nobody reads is not a control. admin_audit_log has existed since
// migration 0048 and has only ever been visible as a per-entity sidebar on a
// practice or customer detail page — so "did anyone touch a practice's
// banking last week?" was a question with no surface that could answer it,
// only a table you would have to already suspect something to go and query.
//
// This is the whole stream, newest first: settlements, banking changes, role
// grants, card retries, notes. It exists to be skimmed.
//
// ─── WHAT THE ROWS MEAN ────────────────────────────────────────────────────
//
// Since 0131 most events are recorded TWICE, by design:
//
//   the trigger    fires on the column change itself, so it cannot be
//                  forgotten by a future code path — but on a service-role
//                  connection auth.uid() is NULL and it shows "unattributed".
//   the call site   knows who, from the action's own authorization guard.
//
// So an unattributed row usually has an attributed twin a second either side
// of it, and the pair is the normal shape. An unattributed row with NO twin
// is the interesting one: a write that arrived from somewhere nobody wired a
// call site into — a cron, a psql session, a new code path. That is exactly
// what this page is for, so those rows are marked rather than hidden.

export const dynamic = 'force-dynamic';

type ActorRef = { first_name: string; last_name: string };

type Row = {
  id:          string;
  actor_id:    string | null;
  entity_type: string;
  entity_id:   string;
  action:      string;
  payload:     Record<string, unknown>;
  created_at:  string;
  actor:       ActorRef | ActorRef[] | null;
};

const PAGE_SIZE = 100;

/** Where a row's entity lives, when the admin portal has a page for it. */
function entityHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case 'practice':  return `/admin/practices/${entityId}`;
    case 'customer':  return `/admin/customers/${entityId}`;
    case 'payment':   return `/admin/collections/${entityId}`;
    // Payout batches and groups have no detail route today.
    default:          return null;
  }
}

/**
 * How loudly a row should read. Money movement and access grants are the two
 * things an operator is scanning for; notes are the background.
 */
function severity(action: string): 'money' | 'access' | 'note' {
  if (action.startsWith('note')) return 'note';
  if (/bank|paid|payout|retry|fee/.test(action)) return 'money';
  if (/role|admin/.test(action))                 return 'access';
  return 'note';
}

const TONE = {
  money:  'border-amber-200 bg-amber-50',
  access: 'border-violet-200 bg-violet-50',
  note:   'border-gray-200 bg-white',
} as const;

/** "grant_sales_role" → "Grant sales role". */
function humanAction(action: string): string {
  const words = action.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin/audit' });

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
  const chip = typeof sp.chip === 'string' ? sp.chip : null;

  // Read through the SESSION client, never service-role: 0048's SELECT policy
  // is is_platform_admin(), and letting RLS do the gating here means this page
  // cannot become the one that leaks the log to a demoted account.
  let query = supabase
    .from('admin_audit_log')
    .select(`
      id, actor_id, entity_type, entity_id, action, payload, created_at,
      actor:profiles!admin_audit_log_actor_id_fkey(first_name, last_name)
    `)
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);

  if (chip === 'money')        query = query.neq('action', 'note');
  if (chip === 'unattributed') query = query.is('actor_id', null);

  const { data: rawRows } = await query;
  const rows = (rawRows ?? []) as Row[];

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-gray-900">Privileged actions</h1>
        <p className="text-sm text-gray-600">
          The last {PAGE_SIZE} recorded admin actions, newest first. Settlements,
          banking changes and role grants are recorded by the database itself,
          so a code path that forgets to log still appears here.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2">
        {[
          { key: null,            label: 'Everything' },
          { key: 'money',         label: 'Actions only (no notes)' },
          { key: 'unattributed',  label: 'Unattributed' },
        ].map(({ key, label }) => (
          <Link
            key={label}
            href={key ? `/admin/audit?chip=${key}` : '/admin/audit'}
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
          Nothing recorded yet.
        </p>
      ) : (
        <ol className="space-y-2">
          {rows.map((row) => {
            const tone   = TONE[severity(row.action)];
            const href   = entityHref(row.entity_type, row.entity_id);
            const actor  = row.actor_id ? fullName(row.actor) : null;
            const detail = JSON.stringify(row.payload);

            return (
              <li key={row.id} className={`rounded-xl border p-3 ${tone}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-gray-900">
                    {humanAction(row.action)}
                  </span>
                  <span className="text-xs text-gray-500" title={row.created_at}>
                    {timeAgo(row.created_at)} · {formatDateTime(row.created_at)}
                  </span>
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {actor ? (
                    <span className="text-gray-700">by {actor}</span>
                  ) : (
                    // Never "by the system". Nothing here is done by a system;
                    // it is done by someone on a connection that did not carry
                    // their identity, and the honest label sends the reader to
                    // the request logs instead of closing the question.
                    <span className="font-medium text-gray-900" data-testid="audit-unattributed">
                      unattributed — no session identity on the write
                    </span>
                  )}
                  <span className="text-gray-500">{row.entity_type}</span>
                  {href && (
                    <Link href={href} className="text-[#13294B] underline underline-offset-2">
                      open
                    </Link>
                  )}
                </div>

                {detail !== '{}' && (
                  <pre className="mt-2 overflow-x-auto text-[11px] leading-relaxed text-gray-700">
                    {detail}
                  </pre>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
