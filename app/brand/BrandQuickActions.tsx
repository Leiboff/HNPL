import Link from 'next/link';
import { brand, cardShadow } from './brandTheme';

// ─── Overview's two quick actions ───────────────────────────────────────────
//
// Lifted verbatim out of ./GroupDashboard, which used to render them above its
// revenue hero. They moved for one reason: GroupDashboard is now just the
// REVENUE section of Overview, and "add a practice" is not a revenue control.
// Same testids, same hrefs, same wording — this is a relocation, not a redesign,
// and the ordering pin that used to read GroupDashboard now reads the page that
// composes both.
//
// Both destinations already existed. "Settings & logo" points at /brand/group,
// which the nav also reaches as its Settings tab; keeping the tile as well is
// deliberate — the nav is for navigating, a quick action is for the thing you
// came to do, and a brand admin's first visit is usually to add their second
// practice.

export default function BrandQuickActions() {
  return (
    <section
      aria-label="Quick actions"
      className="grid grid-cols-1 sm:grid-cols-2 gap-3"
      data-testid="group-quick-actions-top"
    >
      <Link
        href="/brand/new-practice"
        className="rounded-2xl px-5 py-4 transition-colors hover:bg-white"
        style={{ border: `1.5px dashed ${brand.mintDeep}`, background: 'transparent' }}
        data-testid="group-add-practice"
      >
        <p className="text-xs uppercase tracking-widest" style={{ color: brand.faint }}>Add</p>
        <p className="text-sm font-semibold mt-1" style={{ color: brand.tealDeep }}>+ Add a practice</p>
      </Link>
      <Link
        href="/brand/group"
        className="rounded-2xl bg-white px-5 py-4 hover:bg-gray-50 transition-colors"
        style={{ boxShadow: cardShadow }}
        data-testid="group-settings"
      >
        <p className="text-xs uppercase tracking-widest" style={{ color: brand.faint }}>Brand</p>
        <p className="text-sm font-semibold mt-1" style={{ color: brand.ink }}>Settings &amp; logo</p>
      </Link>
    </section>
  );
}
