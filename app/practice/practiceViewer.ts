// ─── Which practice is this viewer looking at, and by what authority? ──
//
// /practice used to answer this inline, from the caller's own
// practice_members rows alone:
//
//   picked = memberRows.find(m => m.practice_id === ?practiceId)
//         || memberRows[0]
//
// Two consequences, both of which this resolver fixes:
//
//   1. A brand-admin who clicked into a branch they hold no
//      practice_members row on did NOT land on that branch. The
//      requested id simply failed to match and the page silently fell
//      back to memberRows[0] — a DIFFERENT practice, with no error. Now
//      that /brand/branch/[practiceId] pivots into this dashboard, that
//      silent fallback would send a brand-admin to the wrong branch's
//      numbers, so an unmatched explicit ?practiceId= is resolved
//      through the real brand path or rejected outright.
//
//   2. There was no way for a brand-admin's authority to reach this page
//      at all, even though it is real authority: 0061 granted
//      brand-admins parallel permissive SELECT policies on practices /
//      practice_members / plans / payments / payouts, keyed on
//      is_brand_admin_of_practice().
//
// WHAT THIS DOES NOT DO — it does not treat a brand-admin as a practice
// member. The two paths stay distinguishable and are reported as such:
//   • member path      — authority from an active practice_members row.
//                        canManagePractice comes from that row.
//   • brand-admin path — authority from an active practice_group_members
//                        row for the practice's group, the same check
//                        app/brand/actions.ts guardBrandAdminOfPractice
//                        makes. canManagePractice is FALSE: brand-admin
//                        authority is not a practice-member capability
//                        and is never silently converted into one.
// Anything else is rejected. Nothing here widens RLS or changes a
// permission rule; both checks read the tables the caller can already
// see, on the caller's OWN client.
//
// Why the brand path needs a service-role reader for page DATA: RLS's
// is_practice_member / is_practice_manager only ever recognise
// practice_members (0002 / 0034 — 0061 deliberately did not widen them,
// nor profiles). So a brand-admin-only caller passes this resolver and
// then reads nothing, or reads plans whose patient/provider name joins
// come back empty. app/practice/pos/devices/page.tsx and
// app/brand/actions.ts already face and document this exact fork and
// resolve it the same way: guard at the app layer, then read with
// service-role, scoped to the one practice that was just authorized.
//
// In practice the brand path is the EDGE case, not the norm:
// createBranch (app/brand/actions.ts) inserts a practice_members row
// with role='admin', can_manage_practice=true for the creating
// brand-admin on every branch it creates, so a brand owner normally
// travels the member path and gets byte-identical rendering for free.
// The brand path covers the invited-brand-admin and
// deactivated-membership cases.

/**
 * Intentionally loose, for the reason lib/practice/tradingGate.ts
 * documents for its own TradingGateSupabase alias (and
 * ./practiceShellAuthority repeats): a structural type for Supabase's
 * deeply-generic PostgREST builder makes TypeScript report "Type
 * instantiation is excessively deep and possibly infinite" at the call
 * sites, because PostgrestBuilder is thenable but not a Promise.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ViewerSupabase = any;

export type PracticeViewerScope = {
  practiceId:        string;
  practiceName:      string;
  feePercent:        number;
  /**
   * The caller's own can_manage_practice on THIS practice. Always false
   * on the brand-admin path — see the note above.
   */
  canManagePractice: boolean;
  /**
   * True when brand-admin authority is the ONLY thing authorising this
   * view (no active practice_members row on this practice). Callers use
   * it to decide which client reads practice-scoped data; it is NOT a
   * capability flag.
   */
  viaBrandAdmin:     boolean;
  /** Active practice_members rows the caller holds, across all practices. */
  membershipCount:   number;
};

export type PracticeViewerResult =
  | { kind: 'ok';       scope: PracticeViewerScope }
  /** No membership anywhere and no explicit practice to authorise. */
  | { kind: 'setup' }
  /** An explicit practiceId the caller has no authority over at all. */
  | { kind: 'denied' };

export async function resolvePracticeViewer(
  /** The caller's OWN authenticated client — both authority checks run here. */
  supabase:    ViewerSupabase,
  /** Service-role, used ONLY to name a practice already authorized above. */
  serviceRole: ViewerSupabase,
  userId:      string,
  requestedPracticeId?: string | null,
): Promise<PracticeViewerResult> {
  // ── Member path ────────────────────────────────────────────────────
  // Unchanged from what the dashboard did inline: order+limit rather
  // than .single(), because post-0062 a brand owner holds N≥2 rows.
  const { data: memberships } = await supabase
    .from('practice_members')
    .select('practice_id, can_manage_practice, created_at, practices(name, fee_percent)')
    .eq('user_id', userId)
    .eq('active', true)
    .order('created_at', { ascending: true });

  const memberRowsRaw = (memberships ?? []) as unknown as Array<{
    practice_id:         string;
    can_manage_practice: boolean | null;
    created_at:          string;
    practices: { name: string; fee_percent: number } | Array<{ name: string; fee_percent: number }> | null;
  }>;
  const memberRows = memberRowsRaw.map((m) => ({
    ...m,
    practices: Array.isArray(m.practices) ? (m.practices[0] ?? null) : m.practices,
  }));

  const picked = requestedPracticeId
    ? memberRows.find((m) => m.practice_id === requestedPracticeId)
    : memberRows[0];

  if (picked) {
    return {
      kind: 'ok',
      scope: {
        practiceId:        picked.practice_id,
        practiceName:      picked.practices?.name ?? '',
        feePercent:        Number(picked.practices?.fee_percent ?? 6),
        canManagePractice: !!picked.can_manage_practice,
        viaBrandAdmin:     false,
        membershipCount:   memberRows.length,
      },
    };
  }

  // No explicit target and no membership to fall back on — the
  // pre-practice signup flow, exactly as before.
  if (!requestedPracticeId) return { kind: 'setup' };

  // ── Brand-admin path ───────────────────────────────────────────────
  // An explicit practice the caller is not a member of. Resolve REAL
  // brand-admin authority over it, on the caller's own client, before
  // anything is read with elevation. Both reads fail closed: a caller
  // with no authority cannot even see the practices row (0061's
  // brand_admin_select_branches is what lets a brand-admin see it), so
  // groupId comes back undefined and this returns 'denied'.
  const { data: practiceRow } = await supabase
    .from('practices')
    .select('group_id')
    .eq('id', requestedPracticeId)
    .maybeSingle();

  const groupId = (practiceRow as { group_id?: string | null } | null)?.group_id;
  if (!groupId) return { kind: 'denied' };

  const { data: brandMembership } = await supabase
    .from('practice_group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .eq('user_id',  userId)
    .eq('active',   true)
    .maybeSingle();

  if (!brandMembership) return { kind: 'denied' };

  // Authorized. Only now does service-role name the practice.
  const { data: practice } = await serviceRole
    .from('practices')
    .select('name, fee_percent')
    .eq('id', requestedPracticeId)
    .maybeSingle();

  return {
    kind: 'ok',
    scope: {
      practiceId:        requestedPracticeId,
      practiceName:      (practice?.name as string | undefined) ?? '',
      feePercent:        Number(practice?.fee_percent ?? 6),
      // NOT inherited from brand authority — a brand-admin is not a
      // practice member and does not acquire a member's capabilities.
      canManagePractice: false,
      viaBrandAdmin:     true,
      membershipCount:   memberRows.length,
    },
  };
}
