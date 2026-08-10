import PracticeHeader from './PracticeHeader';
import PracticeNav from './PracticeNav';

type Props = {
  practiceName: string;
  children: React.ReactNode;
  /**
   * Practice scope threaded onto nav links so the sidebar preserves
   * ?practiceId= when a brand-admin has N≥2 branches. Optional — solo
   * callers (or the /practice/members surface pre-multi-practice)
   * render the sidebar without a scope-carrying suffix.
   */
  practiceId?: string;
  /**
   * True when the current user is a brand-admin of the current
   * practice's brand. Drives whether the sidebar shows the
   * "Practice details" link (which lands on /brand/branch/{id}) —
   * a non-brand-admin lands on notFound() there, so we hide the
   * link rather than expose a dead route.
   */
  isBrandAdmin?: boolean;
  /**
   * True when the current user has manager-tier authority over the
   * current practice — can_manage_practice OR isBrandAdmin. Drives
   * whether the sidebar shows the "Till devices" link
   * (/practice/pos/devices), matching the exact authority
   * guardTillManager() checks server-side.
   */
  canManageTill?: boolean;
};

export default function PracticeShell({
  practiceName,
  children,
  practiceId,
  isBrandAdmin = false,
  canManageTill = false,
}: Props) {
  return (
    <div className="min-h-screen bg-[#f7fbfb]">
      <PracticeHeader practiceName={practiceName} />
      <div className="flex">
        <PracticeNav practiceId={practiceId} isBrandAdmin={isBrandAdmin} canManageTill={canManageTill} />
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}
