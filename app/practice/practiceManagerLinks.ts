// ─── The single source for BOTH nav surfaces' links ────────────────────
//
// The bug this module was created for: "Till devices" was added to
// PracticeNav (desktop sidebar) but not to PracticeHeader's mobile
// hamburger menu — two hand-maintained link lists that silently
// diverged. The permission-gated links moved here so they could not
// diverge again by construction.
//
// WHAT CHANGED IN THE RESTRUCTURE
// ──────────────────────────────
// The nav is now Dashboard · Bills · Team · Settings, and the BASE links
// moved in here too. They were the half still hand-written on each
// surface, and adding "Bills" to two arrays would have been the original
// bug all over again — the same class of link, the same two files.
//
// One deliberate difference survives, and it is now a PARAMETER rather
// than a divergence: the Team entry reads "Team" on desktop and "Manage
// Practice" on mobile. That wording predates all of this and was never
// the bug, so it is preserved exactly — passed in as `teamLabel`.
//
// A second, real bug is fixed by the move: the mobile base links were
// hardcoded '/practice' and '/practice/members' with NO ?practiceId=,
// while desktop's carried it. A brand-admin viewing one branch on mobile
// lost their branch scope the moment they tapped Dashboard or Manage
// Practice. One source cannot produce two different href sets, so both
// surfaces now scope identically.
//
// "Till devices" and "Practice details" are GONE as separate entries —
// they are sections of Settings now (see ./settings/settingsSections).
// Their routes still resolve: both are thin redirects into the matching
// Settings section, so every existing inbound link keeps working.
//
// Payouts joined in the same commit as its route, as promised — see the
// base links below for why it is a BASE link and not a gated one.

import {
  canSeeAnySettingsSection,
  SETTINGS_LABEL,
} from './settings/settingsSections';

export type ManagerLink = { href: string; label: string };

export type ManagerLinkContext = {
  practiceId?:    string;
  /** can_manage_practice OR isBrandAdmin — the exact authority
   *  app/practice/pos/devices/actions.ts's guardTillManager() checks, and
   *  what gates the Till devices SECTION of Settings. */
  canManageTill?: boolean;
  /** Active practice_group_members row for the practice's brand. Gates the
   *  practice-details and banking SECTIONS of Settings. */
  isBrandAdmin?:  boolean;
  /**
   * Practices in this practice's brand (resolvePracticeShellAuthority).
   * Only consulted for the brand exit link below — see getBrandExitLink.
   */
  brandPracticeCount?: number;
};

/** `?practiceId=` or nothing — never `?practiceId=undefined`. */
function scopeOf(practiceId?: string): string {
  return practiceId ? `?practiceId=${encodeURIComponent(practiceId)}` : '';
}

// ─── Base links ────────────────────────────────────────────────────────
//
// Visible to everyone who can reach the practice area at all. Bills is
// among them deliberately: the list is readable by any member (the same
// plans the dashboard already shows them), and the CREATE path inside it
// stays gated by the trading gate through the shared CreateBillButton.
//
// PAYOUTS IS A BASE LINK, not a gated one, and that follows the database
// rather than a judgement call: payout_batches is is_practice_member
// (0090) and payouts was widened from manager-only to is_practice_member
// by 0092 — specifically so the plan breakdown behind a batch total is
// visible to everyone who can see the total. Gating the nav entry on
// can_manage_practice would re-introduce by hand the asymmetry that
// migration removed, and would hide a page RLS is happy to serve. The
// page itself is read-only; a practice cannot mark its own money paid
// (0090 grants no practice-side write policy at all).

export type BaseLinkContext = {
  practiceId?: string;
  /** 'Team' on desktop, 'Manage Practice' on mobile — see the header. */
  teamLabel:   string;
};

export function getPracticeBaseLinks({ practiceId, teamLabel }: BaseLinkContext): ManagerLink[] {
  const scopeSuffix = scopeOf(practiceId);
  return [
    { href: `/practice${scopeSuffix}`,         label: 'Dashboard' },
    { href: `/practice/bills${scopeSuffix}`,   label: 'Bills'     },
    { href: `/practice/payouts${scopeSuffix}`, label: 'Payouts'   },
    { href: `/practice/members${scopeSuffix}`, label: teamLabel   },
  ];
}

// ─── Conditional links ─────────────────────────────────────────────────

export function getPracticeManagerLinks({
  practiceId,
  canManageTill = false,
  isBrandAdmin  = false,
}: ManagerLinkContext): ManagerLink[] {
  const links: ManagerLink[] = [];

  // Settings — practice details, banking, and till devices, each keeping
  // the authority its own screen enforced. The visibility condition is
  // NOT hand-written here: it is the same helper the Settings page uses to
  // decide whether it has anything to render, so a visible nav item and a
  // page that will serve you can never disagree.
  if (canSeeAnySettingsSection({ isBrandAdmin, canManageTill })) {
    links.push({ href: `/practice/settings${scopeOf(practiceId)}`, label: SETTINGS_LABEL });
  }

  return links;
}

/** Label kept in one place — both nav surfaces and their tests read it. */
export const ALL_PRACTICES_LABEL = '← All practices';

// ─── Brand exit link ───────────────────────────────────────────────────
//
// A brand-admin who clicks into a branch lands in that practice's
// ordinary dashboard, wearing a brand-admin hat with nothing on screen
// saying so. Without a persistent way back up they are stranded in one
// practice. This is that way back, and it lives here — in the SAME
// shared source as everything else — so neither nav surface hand-writes
// it and the desktop/mobile parity guard covers it too.
//
// It renders ABOVE each surface's base list (it's an exit upward, not a
// peer of Dashboard/Bills/Team), which is why it's a separate function
// rather than another entry in the arrays above.
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

// ─── The whole nav, in order ───────────────────────────────────────────
//
// Both surfaces call ONLY this. Nothing is spliced by hand at either call
// site any more, which is what makes the parity guard's job structural
// rather than a matter of two files happening to agree today.
export function getPracticeNavLinks(
  ctx: ManagerLinkContext & { teamLabel: string },
): ManagerLink[] {
  const exitLink = getBrandExitLink(ctx);
  return [
    ...(exitLink ? [exitLink] : []),
    ...getPracticeBaseLinks({ practiceId: ctx.practiceId, teamLabel: ctx.teamLabel }),
    ...getPracticeManagerLinks(ctx),
  ];
}
