'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

/**
 * Record that the patient dismissed the post-login passkey prompt.
 *
 * The patient page reads `passkey_prompt_dismissed_count` (capped by app
 * logic at 2: an initial show + one re-prompt 30+ days later). Every
 * explicit dismissal — and any WebAuthn ceremony the user cancels — calls
 * this action so we never re-show within a 30-day window.
 */
export async function dismissPasskeyPrompt(): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { data: current } = await supabase
    .from('profiles')
    .select('passkey_prompt_dismissed_count')
    .eq('id', user.id)
    .single();

  const nextCount = Math.min((current?.passkey_prompt_dismissed_count ?? 0) + 1, 2);

  const { error } = await supabase
    .from('profiles')
    .update({
      passkey_prompt_dismissed_at:    new Date().toISOString(),
      passkey_prompt_dismissed_count: nextCount,
    })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient');
  return { error: null };
}
