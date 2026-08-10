// ─── Shared manager-tier conditional nav links ─────────────────────────
//
// The bug this fixes: "Till devices" was added to PracticeNav (desktop
// sidebar) but not to PracticeHeader's mobile hamburger menu — two
// hand-maintained link lists that silently diverged. Dashboard and
// Team/Manage Practice stay each surface's OWN base list (their labels
// already differ by design — "Team" on desktop, "Manage Practice" on
// mobile — and unifying that wasn't asked for). But the CONDITIONAL,
// permission-gated links — the class of link that actually diverged —
// are computed here ONCE and spliced onto both surfaces' base list, so
// they cannot diverge again by construction, independent of the
// render-level regression test in PracticeNav.test.tsx that also
// compares the two surfaces' rendered output.

export type ManagerLink = { href: string; label: string };

export type ManagerLinkContext = {
  practiceId?:    string;
  /** can_manage_practice OR isBrandAdmin — the exact authority
   *  app/practice/pos/devices/actions.ts's guardTillManager() checks. */
  canManageTill?: boolean;
  /** Active practice_group_members row for the practice's brand. */
  isBrandAdmin?:  boolean;
};

export function getPracticeManagerLinks({
  practiceId,
  canManageTill = false,
  isBrandAdmin  = false,
}: ManagerLinkContext): ManagerLink[] {
  const scopeSuffix = practiceId
    ? `?practiceId=${encodeURIComponent(practiceId)}`
    : '';

  const links: ManagerLink[] = [];
  if (canManageTill) {
    links.push({ href: `/practice/pos/devices${scopeSuffix}`, label: 'Till devices' });
  }
  if (isBrandAdmin && practiceId) {
    links.push({ href: `/brand/branch/${practiceId}`, label: 'Practice details' });
  }
  return links;
}
