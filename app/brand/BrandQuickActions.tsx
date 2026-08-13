import Link from 'next/link';

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
        className="rounded-xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3 hover:bg-gray-50"
        data-testid="group-add-practice"
      >
        <p className="text-xs uppercase tracking-widest text-gray-500">Add</p>
        <p className="text-sm font-semibold mt-1" style={{ color: '#13294B' }}>+ Add a practice</p>
      </Link>
      <Link
        href="/brand/group"
        className="rounded-xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3 hover:bg-gray-50"
        data-testid="group-settings"
      >
        <p className="text-xs uppercase tracking-widest text-gray-500">Brand</p>
        <p className="text-sm font-semibold mt-1" style={{ color: '#13294B' }}>Settings &amp; logo</p>
      </Link>
    </section>
  );
}
