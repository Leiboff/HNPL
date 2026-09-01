import { createClient } from '@/lib/supabase/server';
import { formatDateTime, fullName } from '../_lib/format';
import AddNoteForm from './AddNoteForm';
import { addNote, type AuditEntityType } from '../_lib/auditActions';

// ─── Admin notes + activity timeline ────────────────────────────────────────
//
// Server component that reads admin_audit_log rows for one entity and
// renders them in reverse-chronological order. The add-note form is a
// client component (AddNoteForm) that wraps the addNote server action.
//
// Rendering separates the kinds of rows the table can carry:
//   action='note'             → free-text note (payload.text)
//   action='fee_changed'      → system row showing the from→to delta
//   action='banking_changed'  → WHERE THE MONEY GOES (migration 0131)
//   action='role_changed'     → an access grant (migration 0131)
//   anything else             → the raw payload, so nothing is dropped
//
// The raw fallback is load-bearing, not laziness: 0131 made the database
// itself the primary writer, so actions can appear here that no TypeScript
// in this repo names. Rendering them badly beats not rendering them.
//
// An UNATTRIBUTED row (actor_id NULL) is one the database recorded on a
// connection with no session identity — a service-role write, the cron, a
// psql session. It is labelled as such rather than shown as '—', because
// "we do not know who" is a finding and an em-dash is not.

type AuditRow = {
  id:          string;
  actor_id:    string;
  action:      string;
  payload:     Record<string, unknown>;
  created_at:  string;
  actor:       { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
};

export default async function AdminNotes({
  entityType,
  entityId,
}: {
  entityType: AuditEntityType;
  entityId:   string;
}) {
  const supabase = await createClient();
  const { data: rawRows } = await supabase
    .from('admin_audit_log')
    .select(`
      id, actor_id, action, payload, created_at,
      actor:profiles!admin_audit_log_actor_id_fkey(first_name, last_name)
    `)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })
    .limit(100);

  const rows = (rawRows ?? []) as AuditRow[];

  return (
    <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-900">Notes & activity</h2>
      </div>

      <AddNoteForm entityType={entityType} entityId={entityId} addNote={addNote} />

      <div className="mt-4 space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-gray-500">No notes yet. Add one above to start the timeline.</p>
        ) : (
          rows.map((row) => <TimelineRow key={row.id} row={row} />)
        )}
      </div>
    </section>
  );
}

function TimelineRow({ row }: { row: AuditRow }) {
  const actor = row.actor_id ? fullName(row.actor) : 'an unattributed write';
  const when  = formatDateTime(row.created_at);

  if (row.action === 'note') {
    const text = typeof row.payload.text === 'string' ? row.payload.text : '';
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
          <span className="font-medium text-gray-700">{actor}</span>
          <span>{when}</span>
        </div>
        <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">{text}</p>
      </div>
    );
  }

  if (row.action === 'fee_changed') {
    const from = typeof row.payload.from === 'number' ? row.payload.from : Number(row.payload.from);
    const to   = typeof row.payload.to   === 'number' ? row.payload.to   : Number(row.payload.to);
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
        <div className="flex items-center justify-between text-xs text-amber-800 mb-1">
          <span className="font-medium">Fee changed by {actor}</span>
          <span>{when}</span>
        </div>
        <p className="text-sm text-amber-900 tabular-nums">
          {from}% → {to}%
        </p>
      </div>
    );
  }

  if (row.action === 'banking_changed' || row.action === 'branch_banking_changed'
      || row.action === 'group_banking_changed') {
    // The single highest-value edit in the product. Rendered loudly, and
    // WITHOUT the account number — 0131's payload carries only a last-4 and a
    // SHA-256, which is what makes "changed and changed back" provable
    // without this table becoming a permanent store of bank accounts.
    const to = (row.payload.to ?? row.payload) as Record<string, unknown>;
    const last4 = typeof to.account_last4 === 'string' ? to.account_last4 : null;
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-3">
        <div className="flex items-center justify-between text-xs text-red-800 mb-1">
          <span className="font-medium">Banking changed by {actor}</span>
          <span>{when}</span>
        </div>
        <p className="text-sm text-red-900">
          {typeof to.bank_name === 'string' && to.bank_name ? to.bank_name : 'Bank not set'}
          {last4 ? ` ••${last4}` : ''}
          {typeof to.branch_code === 'string' && to.branch_code ? ` · branch ${to.branch_code}` : ''}
          {typeof to.account_holder === 'string' && to.account_holder ? ` · ${to.account_holder}` : ''}
        </p>
      </div>
    );
  }

  if (row.action === 'role_changed' || row.action === 'grant_sales_role'
      || row.action === 'revoke_sales_role') {
    const from = typeof row.payload.from === 'string' ? row.payload.from : '?';
    const to   = typeof row.payload.to   === 'string' ? row.payload.to   : '?';
    return (
      <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
        <div className="flex items-center justify-between text-xs text-violet-800 mb-1">
          <span className="font-medium">Role changed by {actor}</span>
          <span>{when}</span>
        </div>
        <p className="text-sm text-violet-900">{from} → {to}</p>
      </div>
    );
  }

  // Unknown action — render the raw JSON so nothing is silently
  // dropped if a future action type appears before this renderer is updated.
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
        <span className="font-medium text-gray-700">{row.action} · {actor}</span>
        <span>{when}</span>
      </div>
      <pre className="text-xs text-gray-700 overflow-x-auto">{JSON.stringify(row.payload, null, 2)}</pre>
    </div>
  );
}
