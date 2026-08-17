import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import { AuthCardShape } from '@/components/loading/shapes';

// Route fallback for signup/patient — the narrow centred auth-card shape, so the
// tinted background and card outline are already correct while the server
// resolves. See components/loading/shapes.tsx.
export default function Loading() {
  return (
    <DelayedSkeleton>
      <AuthCardShape label="Loading sign up" fields={4} />
    </DelayedSkeleton>
  );
}
