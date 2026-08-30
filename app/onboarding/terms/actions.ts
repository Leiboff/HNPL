'use server';

import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { TERMS_VERSION } from '@/lib/legal/terms';
import { PRIVACY_VERSION } from '@/lib/legal/privacy';

// ─── acceptTerms — the OAuth path's "I agree" ──────────────────────────
//
// The email signup gates on its tick inside signUpPatient, server-side,
// before the account exists. This is the same decision for a path that
// has no such form: a Google signup arrives with an account already
// created and nothing agreed to.
//
// Gated server-side for the same reason signUpPatient is: the checkbox
// is a client-side affordance and a hand-crafted POST can omit it. The
// acceptance has to be a server decision or it is not one.

export type AcceptTermsResult = { error: string | null };

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function acceptTerms(accepted: boolean): Promise<AcceptTermsResult> {
  if (!accepted) return { error: 'Please accept the betternow terms to continue.' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Please sign in again.' };

  // Stamped with the versions in force, from the same single sources
  // every other acceptance path reads (migrations 0081 + 0082).
  //
  // Write-once: an existing acceptance is an audit fact and is never
  // re-versioned by a later visit, so this matches only rows where the
  // column is still NULL. Re-submitting is then a harmless no-op rather
  // than a rewrite of what the customer originally agreed to.
  const { error } = await svc()
    .from('profiles')
    .update({
      terms_accepted_at: new Date().toISOString(),
      terms_version:     TERMS_VERSION,
      privacy_version:   PRIVACY_VERSION,
    })
    .eq('id', user.id)
    .is('terms_accepted_at', null);

  if (error) return { error: error.message };
  return { error: null };
}
