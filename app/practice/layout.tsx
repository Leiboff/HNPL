import InactivityGuard from '@/lib/auth/InactivityGuard';
import { getRequestUser } from '@/lib/auth/requestUser';

// ─── Practice layout — inactivity guard wrapper ────────────────────────
//
// Practice routes never had a layout.tsx — each page rendered its own
// PracticeShell client component. That still works, but we need a
// single place to mount the shared InactivityGuard for the whole
// /practice/* tree. This layout is intentionally minimal: it passes
// {children} through unchanged (PracticeShell still owns the header /
// sidebar / bg) and mounts the guard.
//
// Auth gating stays where it was — every /practice/* page runs its
// own requireConfirmedUser + role check. We deliberately don't
// duplicate that here; a layout-level guard would need to know the
// specific redirect target for the current page, and the pages
// already handle it cleanly.

export default async function PracticeLayout({ children }: { children: React.ReactNode }) {
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
