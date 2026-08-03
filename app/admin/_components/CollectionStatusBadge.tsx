// ─── Collection status badge ────────────────────────────────────────────────
//
// Maps the payments.status enum + (for status='scheduled') the
// due_date-vs-today relationship into a small set of user-facing
// labels and colours. Used on the collections list AND the detail
// page so the same vocabulary is shown in both places.
//
// payments.status enum (0001 + 'defaulted' added by 0057):
//   'scheduled' | 'processing' | 'collected' | 'failed' | 'retried'
//   | 'written_off' | 'defaulted'
//
// We surface 'scheduled' rows differently depending on whether their
// due_date is in the past or future — both share the same underlying
// status but mean very different things operationally:
//   • due_date >= today → "Upcoming"
//   • due_date <  today → "Overdue" (cron hasn't picked it up yet)
//
// 'defaulted' is the dunning ladder's terminal state (cap of fees
// reached; debt still owed, still self-settleable, and it freezes the
// patient out of new plans). It gets its own bucket so admins can see
// it distinctly from in-flight 'failed'.
//
// 'retried' is in the CHECK constraint but no code path sets it today
// (the webhook only sets 'collected' / 'failed' / 'defaulted'; the cron
// only sets 'processing'). We map it to the same bucket as 'failed' for
// safety should anything historically wrote it.

export type CollectionBucket =
  | 'upcoming'
  | 'overdue'
  | 'processing'
  | 'failed'
  | 'collected'
  | 'written_off'
  | 'defaulted';

type Row = { status: string; due_date: string };

export function classifyCollection(row: Row, today: string): CollectionBucket {
  switch (row.status) {
    case 'scheduled':
      return row.due_date < today ? 'overdue' : 'upcoming';
    case 'processing':
      return 'processing';
    case 'failed':
    case 'retried':
      return 'failed';
    case 'collected':
      return 'collected';
    case 'written_off':
      return 'written_off';
    case 'defaulted':
      return 'defaulted';
    default:
      return 'failed';  // unknown status — surface for investigation
  }
}

const CFG: Record<CollectionBucket, { label: string; cls: string }> = {
  upcoming:    { label: 'Upcoming',       cls: 'bg-blue-50  text-blue-700  border-blue-200'  },
  overdue:     { label: 'Overdue',        cls: 'bg-red-50   text-red-700   border-red-200'   },
  processing:  { label: 'Awaiting',       cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  failed:      { label: 'Failed',         cls: 'bg-red-50   text-red-700   border-red-200'   },
  collected:   { label: 'Collected',      cls: 'bg-green-50 text-green-700 border-green-200' },
  written_off: { label: 'Written off',    cls: 'bg-gray-100 text-gray-600  border-gray-200'  },
  defaulted:   { label: 'Defaulted',      cls: 'bg-red-100  text-red-800   border-red-300'   },
};

export default function CollectionStatusBadge({
  bucket,
}: {
  bucket: CollectionBucket;
}) {
  const c = CFG[bucket];
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${c.cls}`}>
      {c.label}
    </span>
  );
}

export const BUCKET_LABELS = CFG;
