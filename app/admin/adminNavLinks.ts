// ─── The single source for the admin portal's nav links ────────────────────
//
// WHY THIS FILE EXISTS
// ────────────────────
// /admin used to render its nav from TWO hand-maintained arrays: NAV_LINKS in
// AdminNav (the desktop sidebar) and LINKS in AdminBottomNav (the mobile
// bar). They had already diverged — the phone was missing CRM, Sales team,
// Audit log and Risk — which is the same shape as the bug that produced
// ../practice/practiceManagerLinks.ts (a link reaching one surface and not
// the other). The mobile bar had a hard reason to diverge: five items is all
// that fits across a 375px phone. A hamburger menu has no such ceiling, so
// with the bar replaced the two surfaces can — and now do — render the same
// list from here.
//
// PARITY IS THE POINT
// ───────────────────
// Every /admin destination is reachable at every width. The old bottom bar
// justified dropping Audit log and Risk as "desk activities", which was true
// of the reading but not of the reaching: a kill switch you can only get to
// by typing a URL from memory is not reachable in a hurry. adminNav.test.tsx
// pins the two surfaces link-for-link so the next tab cannot land on one and
// miss the other.
//
// NO GATING, ON PURPOSE
// ─────────────────────
// Unlike the practice nav's Settings entry, every link here is unconditional:
// app/admin/layout.tsx bounces anyone whose profile role is not 'admin'
// before a single tab renders, so a viewer who can see this nav can use all
// of it. If an admin sub-role ever lands, its gate belongs HERE, next to the
// link, the way the practice side's does.

/** The badge counts the layout fetches once and threads into both surfaces. */
export type AdminCounts = {
  pendingPractices:    number;
  overdueCollections:  number;
  pendingPayouts:      number;
};

export type AdminLink = {
  href:      string;
  label:     string;
  /** Which of the layout's counts renders as this entry's badge, if any. */
  countKey?: keyof AdminCounts;
};

const LINKS: readonly AdminLink[] = [
  { href: '/admin',                          label: 'Dashboard'                                          },
  { href: '/admin/practices?status=pending', label: 'Practices',   countKey: 'pendingPractices'           },
  { href: '/admin/customers',                label: 'Customers'                                          },
  { href: '/admin/collections?chip=overdue', label: 'Collections', countKey: 'overdueCollections'         },
  { href: '/admin/payouts',                  label: 'Payouts',     countKey: 'pendingPayouts'             },
  { href: '/crm',                            label: 'CRM'                                                },
  { href: '/admin/sales-team',               label: 'Sales team'                                         },
  // The privileged-action log — see app/admin/audit/page.tsx.
  { href: '/admin/audit',                    label: 'Audit log'                                          },
  // The fraud review queue and the platform kill switches (audit S-07).
  { href: '/admin/risk',                     label: 'Risk'                                               },
  // The platform's own knobs — the configurable bill maximum and what
  // else lands beside it (#92). Arrived on master while the two nav
  // arrays were being collapsed into this one; adding it HERE is the
  // whole point, since a link added to the desktop array alone is the
  // bug this file exists to prevent, and the phone gets it for free.
  { href: '/admin/settings',                 label: 'Settings'                                           },
] as const;

/** A fresh array per call, so no caller can mutate the shared list. */
export function getAdminNavLinks(): AdminLink[] {
  return LINKS.map((l) => ({ ...l }));
}

/**
 * Is `href` the tab for `pathname`?
 *
 * '/admin' needs an EXACT match — it is a prefix of every other admin route,
 * so a startsWith test would light Dashboard up on every tab. The rest use
 * startsWith so a child route stays under its parent tab (/admin/practices/[id]
 * keeps Practices lit). Query strings are scope, not identity, so they are
 * stripped before comparing — /admin/practices?status=pending must still match
 * a pathname of /admin/practices.
 */
export function isAdminNavActive(href: string, pathname: string): boolean {
  const path = href.split('?')[0];
  if (path === '/admin') return pathname === path;
  return pathname.startsWith(path);
}

/** The count to render beside `link`, or 0 when it carries no badge. */
export function adminLinkCount(link: AdminLink, counts: AdminCounts): number {
  return link.countKey ? counts[link.countKey] : 0;
}
