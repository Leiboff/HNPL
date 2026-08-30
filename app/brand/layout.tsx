import InactivityGuard from '@/lib/auth/InactivityGuard';
import { getRequestUser } from '@/lib/auth/requestUser';

// ─── Brand layout — inactivity guard wrapper ───────────────────────────
//
// Brand routes previously rendered with only the ROOT layout wrapping
// them. This layout is a thin wrapper that mounts the shared
// InactivityGuard for the whole /brand/* tree. The individual pages
// already do their own auth + brand-admin membership checks — we
// don't duplicate them here.

export default async function BrandLayout({ children }: { children: React.ReactNode }) {
  // Read-only, and memoised per request by cache() in requestUser.ts, so
  // this costs nothing on pages that already call it. Deliberately NOT a
  // gate: the note above still holds — each page owns its own
  // requireConfirmedUser + role check and its own redirect target.
  const user = await getRequestUser();

  return (
    <>
      {children}
      <InactivityGuard
        minutesIdle={10}
        minutesWarn={5}
        sessionStartedAt={Date.parse(user?.last_sign_in_at ?? '')}
      />
    </>
  );
}
