'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireAAL2 } from '@/lib/auth/aal';
import { decideRiskReview, setKillSwitch, type RiskBlockSpec } from '@/lib/risk/admin';
import { RISK_DIMENSIONS, RISK_KILL_SWITCHES, type RiskKillSwitch } from '@/lib/risk/vocabulary';

// ─── The operator surface for the fraud controls ────────────────────────────
//
// Two actions, and the reason they exist as actions at all rather than as a
// psql runbook is the audit's own framing: manual-review states and kill
// switches are controls only if somebody can reach them at 03:00 without a
// deploy and without a database console.
//
// Both go through the SECURITY DEFINER functions in 0142, which stamp the
// actor and write the 0048 audit trail. Neither of those functions checks
// authorization — that is this file's job, and the RPCs are service-role only
// (0125's EXECUTE allow-list) so this is the only way to reach them.

async function guardAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated.', userId: null };
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (p?.role !== 'admin') return { ok: false as const, error: 'Unauthorized.', userId: null };
  return { ok: true as const, error: null, userId: user.id };
}

// ─── decideReview ───────────────────────────────────────────────────────────
//
// Clearing a review lets a held customer or practice transact. Rejecting one
// writes standing blocks that will refuse them. Both are consequential
// decisions about a named person or business, which is why this is a
// 'standard' AAL2 tier rather than an ungated action — but not 'critical':
// unlike a settlement, neither outcome moves money and both are reversible by
// another admin.

export async function decideReview(input: {
  reviewId: string;
  state:    'in_review' | 'cleared' | 'rejected';
  notes?:   string;
  blocks?:  RiskBlockSpec[];
}): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const aal = await requireAAL2('standard');
  if (!aal.ok) return { error: aal.error };

  if (!['in_review', 'cleared', 'rejected'].includes(input.state)) {
    return { error: 'Unknown review state.' };
  }

  // The blocks come from a form, so they are attacker-shaped input even
  // though the attacker would have to be an admin. Validated against the
  // declared vocabulary here as well as in the database: a block on a
  // dimension nothing evaluates is a control that silently does nothing, and
  // finding that out during an incident is the wrong time.
  const blocks = (input.blocks ?? []).filter(
    (b) =>
      (RISK_DIMENSIONS as readonly string[]).includes(b.dimension) &&
      typeof b.token === 'string' &&
      b.token.trim().length > 0 &&
      ['friction', 'review', 'deny'].includes(b.action),
  );

  const result = await decideRiskReview(input.reviewId, input.state, guard.userId!, {
    notes: input.notes?.slice(0, 2_000),
    blocks,
  });

  if (!result.ok) {
    // `already_decided` is the one worth naming: two admins working the same
    // queue is normal, and "someone got there first" is not an error the
    // second one should read as a system fault.
    return {
      error: result.error === 'already_decided'
        ? 'This review has already been decided by someone else.'
        : 'Could not record the decision. Please try again.',
    };
  }

  revalidatePath('/admin/risk');
  return { error: null };
}

// ─── toggleKillSwitch ───────────────────────────────────────────────────────
//
// 'critical' AAL2, matching payout settlement, and for a comparable reason in
// the opposite direction: engaging `credit_issuance` or `payouts` stops the
// business, and a session hijacked earlier in the day must not be able to do
// that. Releasing one is the same call and is if anything more sensitive —
// an attacker's most useful move against these controls is to turn them off.

export async function toggleKillSwitch(input: {
  name:    RiskKillSwitch;
  engaged: boolean;
  reason?: string;
}): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const aal = await requireAAL2('critical');
  if (!aal.ok) return { error: aal.error };

  if (!(RISK_KILL_SWITCHES as readonly string[]).includes(input.name)) {
    return { error: 'Unknown kill switch.' };
  }

  const result = await setKillSwitch(
    input.name,
    input.engaged,
    guard.userId!,
    input.reason?.slice(0, 500),
  );
  if (!result.ok) return { error: 'Could not change the switch. Please try again.' };

  revalidatePath('/admin/risk');
  return { error: null };
}
