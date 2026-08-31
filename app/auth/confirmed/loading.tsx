import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import { AuthSurfaceShape } from '@/components/loading/shapes';

// Route fallback for auth/confirmed — the narrow centred auth-card shape, so the
// tinted background and card outline are already correct while the server
// resolves. See components/loading/shapes.tsx.
export default function Loading() {
  return (
    <DelayedSkeleton>
      <AuthSurfaceShape label="Confirming your email" fields={1} />
    </DelayedSkeleton>
  );
}
