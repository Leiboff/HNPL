import { CollectionStatusBadge } from 'hnpl';

const BUCKETS = ['upcoming','overdue','processing','failed','collected','written_off','defaulted'] as const;

export function AllStatuses() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 20, alignItems: 'flex-start' }}>
      {BUCKETS.map((b) => <CollectionStatusBadge key={b} bucket={b} />)}
    </div>
  );
}
