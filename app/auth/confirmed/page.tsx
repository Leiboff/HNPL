import { createClient } from '@/lib/supabase/server';
import ConfirmedView from './ConfirmedView';

// ─── Email-confirmed landing ───────────────────────────────────────────
//
// After Supabase verifies the confirmation link, users land here with
// a session cookie set. The old page rolled its own tiny role map
// that duplicated the dispatcher — that map is now gone: every
// authenticated confirmation routes through /dashboard, so the role
// → destination decision (including the brand-admin check) lives in
// ONE place. Unauthenticated confirmations (expired-link, etc.) still
// see the resend-email UI in ConfirmedView.

export default async function ConfirmedPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Authenticated → dispatcher owns routing. Unauthenticated (expired
  // link) → login page has the resend flow; keep /login as a safe
  // fallback for the ConfirmedView's error state.
  const destination = user ? '/dashboard' : '/login';

  return <ConfirmedView destination={destination} />;
}
