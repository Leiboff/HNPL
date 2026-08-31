import PracticeHeader from './PracticeHeader';
import PracticeNav from './PracticeNav';

type Props = {
  practiceName: string;
  children: React.ReactNode;
  /**
   * Practice scope threaded onto nav links (both the desktop sidebar
   * and the mobile header menu) so they preserve ?practiceId= when a
   * brand-admin has N≥2 branches. Optional — solo callers (or the
   * /practice/members surface pre-multi-practice) render the nav
   * without a scope-carrying suffix.
   */
  practiceId?: string;
  /**
   * True when the current user is a brand-admin of the current
   * practice's brand. Drives whether the desktop sidebar AND the
   * mobile header menu show the "Practice details" link (which lands
   * on /brand/branch/{id}) — a non-brand-admin lands on notFound()
   * there, so we hide the link rather than expose a dead route.
   */
  isBrandAdmin?: boolean;
  /**
   * True when the current user has manager-tier authority over the
   * current practice — can_manage_practice OR isBrandAdmin. Drives
   * whether the desktop sidebar AND the mobile header menu show the
   * "Till devices" link (/practice/pos/devices), matching the exact
   * authority guardTillManager() checks server-side. Both surfaces
   * derive this link from the same getPracticeManagerLinks() helper
   * (./practiceManagerLinks) so they can't diverge again.
   */
  canManageTill?: boolean;
  /**
   * Practices in the current practice's brand, from
   * resolvePracticeShellAuthority. Drives the "← All practices" exit
   * link on BOTH nav surfaces (see getBrandExitLink) — a brand-admin
   * sitting inside one branch's dashboard needs a persistent way back to
   * the brand view, and a practice's own staff must never see it.
   * isBrandAdmin alone is not the condition: a solo owner is
   * auto-brand-admin of their own 1-practice brand.
   */
  brandPracticeCount?: number;
};

export default function PracticeShell({
  practiceName,
  children,
  practiceId,
  isBrandAdmin = false,
  canManageTill = false,
  brandPracticeCount = 0,
}: Props) {
  return (
    <div className="min-h-screen bg-background">
      <PracticeHeader
        practiceName={practiceName}
        practiceId={practiceId}
        isBrandAdmin={isBrandAdmin}
        canManageTill={canManageTill}
        brandPracticeCount={brandPracticeCount}
      />
      <div className="flex">
        <PracticeNav
          practiceId={practiceId}
          isBrandAdmin={isBrandAdmin}
          canManageTill={canManageTill}
          brandPracticeCount={brandPracticeCount}
        />
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}
