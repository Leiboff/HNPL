import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import { AuthSurfaceShape } from '@/components/loading/shapes';

// Route fallback for verify-email — the auth-surface shape, so the navy
// ground and the field stack are already correct while the server
// resolves. See components/loading/shapes.tsx.
export default function Loading() {
  return (
    <DelayedSkeleton>
      <AuthSurfaceShape label="Loading email verification" fields={1} />
    </DelayedSkeleton>
  );
}
