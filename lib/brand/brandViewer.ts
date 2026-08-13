// ─── Who is this brand admin, and which practices are theirs? ───────────────
//
// Every screen under /brand opens with the same twenty lines: read the caller's
// own active practice_group_members rows, bail to /practice if there are none,
// pull the practices in those groups with service-role, then apply the n=0 /
// n=1 / n>=2 rule. /brand/page.tsx and /brand/revenue/page.tsx each carry their
// own copy, and /brand/practices would have been the third.
//
// This is that logic, once. It is the brand-side counterpart of
// ../../app/practice/practiceViewer.ts and follows the same two conventions:
//
//   AUTHORITY comes from the CALLER'S OWN client, so RLS is the boundary and a
//   group_id can never arrive from a URL. That read is the whole security
//   decision this module makes.
//
//   DATA comes from service-role, scoped to the group_ids just proven. Not
//   because RLS would refuse it — brand_admin_select_branches (0061) allows it —
//   but for the reason /brand/revenue's header already gives: reading with
//   service-role AFTER the guard means a policy gap can never widen the result
//   set beyond the caller's own groups, because the .in() is built from their
//   own membership rows.
//
// THE n RULE, UNCHANGED
//   n = 0  → the brand has no practices yet         → /practice/setup
//   n = 1  → a brand surface would say "practices"  → /practice?practiceId=…
//            about one practice, and every brand
//            screen would be a worse version of
//            that practice's own dashboard
//   n >= 2 → render the brand portal
//
// It is returned as a discriminated union rather than executed here, because
// redirect() belongs to the page: a lib that redirects is a lib that cannot be
// unit-tested without a Next.js request scope, and the n=1 rule is exactly the
// kind of thing worth testing directly.

/**
 * Loose structural type, same reason as lib/practice/tradingGate.ts and
 * lib/practice/setupChecklist.ts: naming Supabase's generic builder here makes
 * TypeScript report "type instantiation is excessively deep" at the call sites.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BrandViewerSupabase = any;

export type BrandInfoRow = {
  id:      string;
  name:    string;
  logoUrl: string | null;
};

export type BrandPracticeRow = {
  id:      string;
  name:    string;
  status:  string;
  suburb:  string | null;
  city:    string | null;
  groupId: string;
  feePct:  number;
};

export type BrandViewer =
  /** No active practice_group_members row at all. */
  | { kind: 'denied' }
  /** Brand membership, but no practices under it yet. */
  | { kind: 'setup' }
  /** Exactly one practice — the brand portal is the wrong screen. */
  | { kind: 'solo'; practiceId: string }
  | {
      kind:      'brand';
      groupIds:  string[];
      brands:    BrandInfoRow[];
      practices: BrandPracticeRow[];
    };

/**
 * @param supabase the caller's OWN client — authority is read through it
 * @param svc      service-role — data only, scoped to the groups just proven
 */
export async function resolveBrandViewer(
  supabase: BrandViewerSupabase,
  svc:      BrandViewerSupabase,
  userId:   string,
): Promise<BrandViewer> {
  // ── Authority. The caller's own client, so RLS decides. ──────────────────
  const { data: rawMemberships } = await supabase
    .from('practice_group_members')
    .select('group_id, active')
    .eq('user_id', userId)
    .eq('active', true);

  const groupIds = [
    ...new Set(((rawMemberships ?? []) as Array<{ group_id: string }>).map((m) => m.group_id)),
  ];
  if (groupIds.length === 0) return { kind: 'denied' };

  // ── Data. Scoped by the .in() built from those very rows. ────────────────
  const { data: rawPractices } = await svc
    .from('practices')
    .select('id, name, status, city, suburb, group_id, fee_percent')
    .in('group_id', groupIds)
    .order('name');

  const practices: BrandPracticeRow[] = ((rawPractices ?? []) as Array<Record<string, unknown>>).map((p) => ({
    id:      p.id      as string,
    name:    (p.name   as string) ?? '—',
    status:  (p.status as string) ?? 'pending',
    suburb:  (p.suburb as string | null) ?? null,
    city:    (p.city   as string | null) ?? null,
    groupId: p.group_id as string,
    feePct:  Number((p.fee_percent as number | null) ?? 0),
  }));

  if (practices.length === 0) return { kind: 'setup' };
  if (practices.length === 1) return { kind: 'solo', practiceId: practices[0].id };

  const { data: rawBrands } = await svc
    .from('practice_groups')
    .select('id, name, logo_url')
    .in('id', groupIds);

  const brands: BrandInfoRow[] = ((rawBrands ?? []) as Array<Record<string, unknown>>).map((g) => ({
    id:      g.id   as string,
    name:    (g.name as string) ?? '—',
    logoUrl: (g.logo_url as string | null) ?? null,
  }));

  return { kind: 'brand', groupIds, brands, practices };
}
