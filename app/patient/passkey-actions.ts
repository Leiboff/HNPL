'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

// ─── Post-login passkey prompt — frequency cap machinery ──────────────
//
// State on `profiles` (added by migration 0065):
//   • login_count                       — total successful logins.
//   • passkey_prompt_next_show_at_login — login_count value at which
//                                         the prompt is next allowed
//                                         to render (default 1 →
//                                         show on first login).
//   • passkey_prompt_permanent_dismiss  — "Don't ask again", never
//                                         show after true.
//
// Trigger rule (evaluated in the patient layout):
//   shouldShow = !permanent_dismiss
//              && !has_passkey                (client self-hides)
//              && login_count >= next_show_at_login
//
// On Skip → next_show_at_login = login_count + 3
// On Don't ask again → permanent_dismiss = true
// On successful registration → passkeys.length > 0 → client self-hides.

/**
 * Increment login_count. Called by the login page after a successful
 * signInWithPassword() so the layout's next render sees the fresh
 * value. Best-effort — a failure here just skips one increment and
 * the next login gets it. The passkey prompt is a nudge; the count
 * is display-decision fuel, not a security counter.
 */
export async function recordLoginLanding(): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { data: current } = await supabase
    .from('profiles')
    .select('login_count')
    .eq('id', user.id)
    .single();

  const next = ((current?.login_count as number | null) ?? 0) + 1;

  const { error } = await supabase
    .from('profiles')
    .update({ login_count: next })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient');
  return { error: null };
}

/**
 * "Skip for now" — bumps next_show_at_login to login_count + 3 so the
 * prompt is suppressed for the next two logins and re-appears on the
 * third.
 */
export async function skipPasskeyPrompt(): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { data: current } = await supabase
    .from('profiles')
    .select('login_count')
    .eq('id', user.id)
    .single();

  const loginCount = (current?.login_count as number | null) ?? 0;

  const { error } = await supabase
    .from('profiles')
    .update({
      passkey_prompt_next_show_at_login: loginCount + 3,
      // Legacy columns from 0037 — keep in sync so any surface still
      // reading the old flags reads consistent state during rollout.
      passkey_prompt_dismissed_at:       new Date().toISOString(),
    })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient');
  return { error: null };
}

/**
 * "Don't ask again" — permanent suppression. Layout skips the prompt
 * unconditionally from this point on. The Security & sign-in tab on
 * the profile remains available for the user to enrol later if they
 * change their mind (they just have to opt in via the profile, not
 * the auto-prompt).
 */
export async function dontAskAgainPasskey(): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { error } = await supabase
    .from('profiles')
    .update({
      passkey_prompt_permanent_dismiss: true,
      // Sensible high value so any legacy count-based check also
      // considers this suppressed.
      passkey_prompt_next_show_at_login: 2_000_000_000,
      passkey_prompt_dismissed_at:       new Date().toISOString(),
    })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient');
  return { error: null };
}

// ─── Legacy compat — the pre-0065 dismissPasskeyPrompt entrypoint ─────
//
// The old home-page PasskeySetupCard used dismissPasskeyPrompt() which
// bumped the pre-existing dismissed_count column. Kept during rollout
// so any lingering caller (or older browser cache) continues to work
// — it now delegates to skipPasskeyPrompt so the new frequency cap
// applies uniformly.

export async function dismissPasskeyPrompt(): Promise<{ error: string | null }> {
  return skipPasskeyPrompt();
}
