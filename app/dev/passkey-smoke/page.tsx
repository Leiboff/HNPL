import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PasskeySmokeClient from './PasskeySmokeClient';

/**
 * Passkey smoke test — dev-mode only.
 *
 * Existence checks before building UI on top of the experimental passkey API:
 *   1. registerPasskey() succeeds against the local Supabase instance
 *   2. signInWithPasskey() returns a session
 *   3. That session is visible to SSR (server component below sees the user)
 *
 * The server-side identity block at the top is the SSR proof: after you sign
 * in client-side via the button below, refresh this page and your email
 * should show up here. If it doesn't, the cookie storage adapter isn't
 * persisting the session and we have a deeper problem to fix before any UI.
 */
export default async function PasskeySmokePage() {
  if (process.env.NODE_ENV !== 'development') notFound();

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold text-gray-900">Passkey smoke test</h1>
          <p className="mt-1 text-sm text-gray-500">
            Dev-mode only. Open the browser console to see structured logs.
          </p>
        </header>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Server-rendered user (SSR proof)
          </p>
          <p className="mt-2 font-mono text-sm text-gray-900">
            {user ? `user.id: ${user.id}` : '(no server-side session)'}
          </p>
          <p className="mt-1 font-mono text-sm text-gray-700">
            {user ? `user.email: ${user.email ?? '(no email)'}` : '—'}
          </p>
        </section>

        <PasskeySmokeClient initialServerUserId={user?.id ?? null} />
      </div>
    </div>
  );
}
