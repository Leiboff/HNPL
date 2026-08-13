// ─── The single source for the brand nav's links ───────────────────────────
//
// WHY THIS FILE EXISTS AT ALL
// ───────────────────────────
// Before this, /brand had no nav. It had one screen (the group dashboard) with
// two "quick action" tiles hand-written inside it, /brand/group hand-writing a
// "← Back to my practices" link of its own, and /brand/revenue — a fully built
// by-practice / by-doctor breakdown — reachable from NOTHING. Not one link in
// the product pointed at it. A screen with no inbound link is a screen that
// does not exist, and it stayed that way precisely because there was no shared
// place a link could be added to.
//
// So this is the brand-side equivalent of ../practice/practiceManagerLinks.ts,
// created for the same reason and deliberately mirroring it: one exported
// function that every surface rendering brand nav calls, so a tab cannot be
// added to one surface and forgotten on another.
//
// ONE SURFACE, ON PURPOSE
// ───────────────────────
// The practice side has TWO nav components (a desktop sidebar and a mobile
// hamburger) because they grew separately, and the bug that produced
// practiceManagerLinks was a link reaching one and not the other. Brand starts
// with nothing, so it starts with ONE responsive component (../brand/BrandNav)
// that renders these tabs at every width. That is strictly stronger than a
// parity guard between two renderers: there is no second surface to diverge
// from. The guard the tests DO enforce is the one that still has teeth — that
// no brand surface hand-writes a nav link of its own, so the day a second
// renderer is added it has to come through here.
//
// NO GATING, AND WHY THAT IS NOT LAZINESS
// ───────────────────────────────────────
// Every link here is unconditional, unlike the practice nav's Settings entry.
// That is a property of who can reach /brand at all: every one of these routes
// resolves the caller's own active practice_group_members rows and bounces
// anyone without one, so a viewer who can see this nav can use all four of its
// destinations. There is no brand-side equivalent of can_manage_practice —
// brand membership is the only authority in play. If a brand-level role ever
// lands, the gate belongs HERE, next to the link, the way Settings' does on the
// practice side.
//
// SETTINGS IS NOT INVENTED
// ────────────────────────
// It points at /brand/group, which already existed as "Brand settings" (name +
// logo; group banking is deliberately platform-admin-only). The tab replaces
// that page's hand-written "← Back to my practices" link as the way in and out.

export type BrandLink = { href: string; label: string };

/**
 * Overview · Practices · Reports · Settings, in order.
 *
 * Reports is /brand/revenue under a name that says what it is. The route keeps
 * its path so the screen is unchanged and any bookmark still resolves — the
 * label is the only thing that differs, because "Revenue" would have implied
 * this is where the money owed to you is, which is Overview's job.
 */
const LINKS: readonly BrandLink[] = [
  { href: '/brand',           label: 'Overview'  },
  { href: '/brand/practices', label: 'Practices' },
  { href: '/brand/revenue',   label: 'Reports'   },
  { href: '/brand/group',     label: 'Settings'  },
] as const;

/** A fresh array per call, so no caller can mutate the shared list. */
export function getBrandNavLinks(): BrandLink[] {
  return LINKS.map((l) => ({ ...l }));
}

/**
 * Is `href` the tab for `pathname`?
 *
 * '/brand' needs an EXACT match — it is a prefix of every other brand route, so
 * a startsWith test would light Overview up on all four tabs. The same rule the
 * practice nav applies to '/brand'-like prefixes ('/practice',
 * '/practice/bills'), for the same reason.
 *
 * The rest use startsWith so a child route stays under its parent tab:
 * /brand/revenue?practice=… keeps Reports lit, and a future
 * /brand/practices/[id] would keep Practices lit.
 */
export function isBrandNavActive(href: string, pathname: string): boolean {
  const path = href.split('?')[0];
  if (path === '/brand') return pathname === path;
  return pathname.startsWith(path);
}
