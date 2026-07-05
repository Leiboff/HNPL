import InactivityGuard from '@/lib/auth/InactivityGuard';

// ─── Brand layout — inactivity guard wrapper ───────────────────────────
//
// Brand routes previously rendered with only the ROOT layout wrapping
// them. This layout is a thin wrapper that mounts the shared
// InactivityGuard for the whole /brand/* tree. The individual pages
// already do their own auth + brand-admin membership checks — we
// don't duplicate them here.

export default function BrandLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <InactivityGuard minutesIdle={10} minutesWarn={10} />
    </>
  );
}
