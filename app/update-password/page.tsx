import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import UpdatePasswordForm from './UpdatePasswordForm';
import AuthSurface from '@/app/_components/AuthSurface';

// ─── /update-password ──────────────────────────────────────────────────
//
// The redirectTo target of the password-reset flow. The user reaches
// this URL AFTER /auth/callback exchanged the PKCE recovery code for a
// session cookie, so we should see an authenticated user on the SSR
// client. We do NOT check role here — the reset is role-agnostic; the
// role-aware landing happens once the password is updated (the form
// redirects to /dashboard, which is our canonical role-dispatcher).
//
// Corner cases:
//   • No session (user typed the URL directly, or the callback failed
//     silently) → bounce to /forgot-password?error=expired so they can
//     request a fresh link. Never a raw 404 or a dead form.
//   • Session but not a recovery session — Supabase treats the
//     recovery link as a full sign-in for the SSR flow, so
//     supabase.auth.updateUser({ password }) is valid whether the
//     caller is in a recovery-scope session or a normal one. The
//     user just re-sets their password; that's fine.

export default async function UpdatePasswordPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // No session ⇒ the recovery link never landed us here with a
    // valid code exchange. Send them back to request one.
    redirect('/forgot-password?error=expired');
  }

  return (
    <AuthSurface centred>
      <UpdatePasswordForm email={user.email ?? ''} />
    </AuthSurface>
  );
}
