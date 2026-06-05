'use server';

// DEV BYPASS: currently rubber-stamps the logged-in patient as identity-verified.
// Brick D will replace the body with a real server-side FaceTec liveness confirmation
// before setting sa_id_verified.

import { createClient } from '@/lib/supabase/server';

export async function markIdentityVerified(): Promise<{ error: string | null; success?: boolean }> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'patient') return { error: 'Not a patient' };

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ sa_id_verified: true })
    .eq('id', user.id);

  if (updateError) return { error: updateError.message };

  return { error: null, success: true };
}
