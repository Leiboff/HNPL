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
  /**
   * Practices in this practice's brand (resolvePracticeShellAuthority).
   * Only consulted for the brand exit link below — see getBrandExitLink.
   */
  brandPracticeCount?: number;
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
  // Practice settings — details + banking. Used to deep-link into
  // /brand/branch/{practiceId}, which was doing double duty as a
  // multi-branch performance view AND the de-facto settings page. That
  // page now pivots into the practice dashboard, and the settings live
  // at /practice/details, inside the shell this nav belongs to.
  //
  // Still isBrandAdmin-gated, unchanged: brand-admin of the practice's
  // group is exactly the authority updateBranchDetails /
  // updateBranchBanking enforce (guardBrandAdminOfPractice), and
  // /practice/details notFound()s anyone else — so a visible link and a
  // working destination continue to agree.
  if (isBrandAdmin && practiceId) {
    links.push({ href: `/practice/details${scopeSuffix}`, label: 'Practice details' });
  }
  return links;
}

/** Label kept in one place — both nav surfaces and their tests read it. */
export const ALL_PRACTICES_LABEL = '← All practices';

// ─── Brand exit link ───────────────────────────────────────────────────
//
// A brand-admin who clicks into a branch now lands in that practice's
// ordinary dashboard, wearing a brand-admin hat with nothing on screen
// saying so. Without a persistent way back up they are stranded in one
// practice. This is that way back, and it lives here — in the SAME
// shared source as the conditional links — so neither nav surface
// hand-writes it and the desktop/mobile parity guard covers it too.
//
// It renders ABOVE each surface's base list (it's an exit upward, not a
// peer of Dashboard/Team), which is why it's a separate function rather
// than another entry in the array above.
//
// Gating is deliberately NOT isBrandAdmin alone: post-0062 every solo
// owner is auto-brand-admin of their own silently-created 1-practice
// brand, and /brand redirects n=1 right back to /practice. So a solo
// practitioner would get a link that bounces and that says "practices"
// plural about their one practice. brandPracticeCount >= 2 is the
// condition under which /brand actually renders something.
//
// A practice's own staff are not brand-admins at all, so they never see
// it — which is the requirement.
export function getBrandExitLink({
  isBrandAdmin       = false,
  brandPracticeCount = 0,
}: ManagerLinkContext): ManagerLink | null {
  if (!isBrandAdmin || brandPracticeCount < 2) return null;
  return { href: '/brand', label: ALL_PRACTICES_LABEL };
}
