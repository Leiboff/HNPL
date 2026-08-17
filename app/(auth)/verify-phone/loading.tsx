import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import { AuthCardShape } from '@/components/loading/shapes';

// Route fallback for (auth)/verify-phone — the narrow centred auth-card shape, so the
// tinted background and card outline are already correct while the server
// resolves. See components/loading/shapes.tsx.
export default function Loading() {
  return (
    <DelayedSkeleton>
      <AuthCardShape label="Loading phone verification" fields={1} />
    </DelayedSkeleton>
  );
}
