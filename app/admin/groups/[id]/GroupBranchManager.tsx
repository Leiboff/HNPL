// ─── Brand-detail: practices listing (read-only for the platform admin) ─
//
// Post-0062 there is no "standalone" tier — every practice belongs to
// a brand. Brand membership is set at signup (auto-created brand,
// invisible to the solo owner) or at add-another-practice time (when
// the brand owner adds a second practice from their dashboard). The
// admin no longer needs an "assign from standalone" or "unassign to
// standalone" affordance here, so this component is a read-only
// listing of the brand's practices.
//
// If platform support ever needs to move a practice between brands,
// that's an offline / DB-direct operation now — not a UI affordance.

type BranchRow = {
  id:        string;
  name:      string;
  status:    string;
  city:      string | null;
  suburb:    string | null;
};

type Props = {
  branches: BranchRow[];
};

const statusStyle = (s: string) =>
  s === 'approved'  ? 'bg-green-100 text-green-700' :
  s === 'pending'   ? 'bg-amber-100 text-amber-700' :
  s === 'suspended' ? 'bg-red-100 text-red-700' :
                      'bg-gray-100 text-gray-500';

export default function GroupBranchManager({ branches }: Props) {
  return (
    <div className="space-y-1">
      {branches.length === 0 ? (
        <p className="text-sm text-gray-500">No practices in this brand yet.</p>
      ) : (
        branches.map((b) => (
          <div key={b.id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{b.name}</p>
              <p className="text-xs text-gray-500">{[b.suburb, b.city].filter(Boolean).join(', ') || '—'}</p>
            </div>
            <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${statusStyle(b.status)}`}>
              {b.status}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
