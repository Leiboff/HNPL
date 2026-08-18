import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';

/**
 * Request-scoped patient profile read — one round trip, two consumers.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────
 *
 * /patient read the SAME profiles row twice on every render: the layout
 * selected fourteen columns for its role gate and onboarding check, and the
 * page separately selected first_name, last_name and approved_credit_limit.
 * Two network round trips for one row, on the screen patients open most.
 *
 * A layout cannot pass props to a page in the App Router, so the usual fix
 * — thread it through — is not available. React's `cache()` is built for
 * exactly this shape: it memoises per REQUEST, so the second caller gets
 * the first caller's result with no round trip, and nothing has to be
 * threaded anywhere.
 *
 * ─── FIRST USE OF cache() IN THIS REPO ────────────────────────────────
 *
 * Introduced deliberately, so: the memo lives for one server request and
 * no longer. It is not a cross-request cache, it does not persist between
 * users, and it cannot serve one patient's row to another — a fresh
 * request gets a fresh memo. That is the property that makes it safe here,
 * where the data is per-user and must never be shared.
 *
 * ─── WHY IT OWNS ITS CLIENT ───────────────────────────────────────────
 *
 * `cache()` keys on argument identity. The layout and the page each build
 * their own Supabase client, so passing the client in would produce two
 * different keys and two misses — the memo would never hit and this file
 * would be pure overhead. Keying on the userId STRING is what makes it
 * work, which is why the client is created inside.
 *
 * ─── ON THE COLUMN LIST ───────────────────────────────────────────────
 *
 * The select is the UNION of the two projections it replaces, so both
 * callers still read exactly the fields they read before and neither sees
 * a different shape. One extra column crosses the wire for the layout
 * (approved_credit_limit) and eleven for the page — against one fewer
 * round trip, which on a mobile network is the trade worth making.
 */
export const getPatientProfileForRequest = cache(async (userId: string) => {
  const supabase = await createClient();
  const { data } = await supabase
    .from('profiles')
    .select(`
      role, first_name, last_name, email, phone,
      login_count, passkey_prompt_next_show_at_login, passkey_prompt_permanent_dismiss,
      phone_verified_at, sa_id_number, salary_day,
      credit_check_status, liveness_verified_at, onboarding_completed,
      approved_credit_limit
    `)
    .eq('id', userId)
    .single();
  return data;
});
