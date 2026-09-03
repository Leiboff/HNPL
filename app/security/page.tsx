import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { isMfaRequiredRole } from '@/lib/auth/privilegedRoles';
import { getSessionAssurance } from '@/lib/auth/aal';
import SecurityClient from './SecurityClient';

// ─── /security — two-factor management for privileged accounts ─────────
//
// The one destination an unenrolled `admin` or `sales` user can reach.
// The sign-in step-up (app/dashboard) routes them here; the operation
// guards and the PII-page gate redirect here on refusal. It is NOT a
// bypass — nothing privileged happens on this page. It only lets the user
// obtain the assurance that everything else demands.
//
// Reachable at aal1 BY DESIGN: an admin who has never enrolled has no way
// to reach aal2 except by enrolling, and enrolment happens here. So the
// only gate on this page is "confirmed user, privileged role". A
// non-privileged role is sent to its own home — this page has nothing for
// them, MFA being out of scope for patient / practice roles this pass.
//
// ?step=enrol|challenge is a hint for the initial view only; the client
// re-derives the true state from the live factor list and AAL, so a stale
// or hand-typed query param cannot put the page into a wrong mode.

type SearchParams = { step?: string; next?: string };

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { step, next } = await searchParams;
  const { user, supabase } = await requireConfirmedUser({ next: '/security' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name')
    .eq('id', user.id)
    .single();

  const role = profile?.role ?? null;

  if (!isMfaRequiredRole(role)) {
    // Out of scope for this page. Send them to the normal dispatcher,
    // which routes each role to its own area. No MFA is imposed on them.
    redirect('/dashboard');
  }

  // Current assurance drives the initial UI. Read from the guard so the
  // page and the enforcement layer can never disagree about what "enrolled"
  // or "aal2" means.
  const assurance = await getSessionAssurance();

  const initialStep: 'enrol' | 'challenge' | 'manage' =
    !assurance.hasVerifiedFactor
      ? 'enrol'
      : assurance.level === 'aal2'
        ? 'manage'
        : step === 'manage'
          ? 'manage'
          : 'challenge';

  const safeNext = typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')
    ? next
    : '/dashboard';

  return (
    <main className="mx-auto max-w-lg px-4 py-8 sm:py-12">
      <h1 className="text-xl font-semibold text-gray-900">Two-factor authentication</h1>
      <p className="mt-2 text-sm text-gray-600">
        {role === 'admin' ? 'Admin' : 'Sales'} accounts require an authenticator app to
        approve merchants, move money, change banking, grant roles and view customer records.
      </p>

      <SecurityClient
        initialStep={initialStep}
        currentLevel={assurance.level}
        hasVerifiedFactor={assurance.hasVerifiedFactor}
        nextPath={safeNext}
      />
    </main>
  );
}
