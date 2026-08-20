import BrandNav from './BrandNav';
import { brand } from './brandTheme';

// ─── Brand chrome — the header and the nav, in one place ────────────────────
//
// The practice tree has PracticeShell; the brand tree had nothing, so each
// brand screen opened with its own hand-rolled <h1> and its own idea of a way
// back. This is the equivalent wrapper: brand name, then the tabs, then the
// screen.
//
// It renders no data of its own and makes no authority decision — every page
// under /brand already resolves the caller's own active practice_group_members
// rows and bounces anyone without one, and duplicating that here is what made
// the brand-admin path 404 once before (see /brand/branch/[practiceId]).
//
// The brand NAME is passed in rather than fetched, for the same reason: the
// pages have already read it while resolving scope, and a fetch here would be a
// second read of a row the caller has just proven they can see.

type Props = {
  /** The brand's display name, or null when the caller admins several. */
  brandName: string | null;
  /**
   * How many brands this caller administers. At 2+ the header says so instead
   * of naming one, because naming the first would misdescribe the page — the
   * practices below span all of them.
   */
  brandCount: number;
  children: React.ReactNode;
};

export default function BrandShell({ brandName, brandCount, children }: Props) {
  const title = brandCount > 1 ? 'My brands' : (brandName ?? 'My practices');

  return (
    <div className="min-h-screen" style={{ background: brand.paper, color: brand.ink }}>
      <header className="bg-white border-b" style={{ borderColor: brand.line }}>
        <div className="mx-auto max-w-3xl px-4 sm:px-6 pt-6 pb-4">
          <p className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: brand.faint }}>
            Brand
          </p>
          <h1
            className="text-2xl sm:text-[28px] font-semibold mt-1 tracking-tight"
            style={{ color: brand.ink }}
            data-testid="brand-shell-title"
          >
            {title}
          </h1>
        </div>
      </header>

      <BrandNav />

      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-10 space-y-6 sm:space-y-8">
        {children}
      </div>
    </div>
  );
}
