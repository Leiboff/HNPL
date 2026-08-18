import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import { ListShape } from '@/components/loading/shapes';

// Route fallback for crm/leads. Shape-matched via the shared compositions —
// see components/loading/shapes.tsx. Wrapped in DelayedSkeleton so a fast
// response shows nothing rather than flashing (components/loading/timing.ts).
export default function Loading() {
  return (
    <DelayedSkeleton>
      <ListShape label="Loading leads" rows={8} />
    </DelayedSkeleton>
  );
}
