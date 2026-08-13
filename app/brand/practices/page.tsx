import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { resolveBrandViewer } from '@/lib/brand/brandViewer';
import { resolveBrandPracticeSetup } from '@/lib/brand/brandPracticeSetup';
import BrandShell from '../BrandShell';
import PracticesTable from './PracticesTable';

// ─── /brand/practices — the admin table ─────────────────────────────────────
//
// The screen that answers "is every branch actually able to trade?" without
// visiting each one. Read-only: it writes nothing and offers no controls of its
// own beyond links into the practices themselves.
//
// SCOPING is resolveBrandViewer's, not this page's: authority from the caller's
// OWN client (their active practice_group_members rows, RLS-enforced), then
// practices pulled with service-role scoped by an .in() built from those very
// rows. A group_id can never arrive from a URL because this route takes no
// params at all. The n=0 / n=1 / n>=2 rule is applied identically to /brand's,
// which is the point of sharing the resolver rather than writing a third copy.
//
// SETUP STATE is service-role by requirement, not convenience — see
// lib/brand/brandPracticeSetup's header. A brand admin normally has no
// practice_members row anywhere, so reading till_devices through their own
// client would return nothing and the table would report "no till" for a
// practice that has three. The page-level guard above is the security boundary.

export const dynamic = 'force-dynamic';

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export default async function BrandPracticesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const s = svc();
  const viewer = await resolveBrandViewer(supabase, s, user.id);

  if (viewer.kind === 'denied') redirect('/practice');
  if (viewer.kind === 'setup')  redirect('/practice/setup');
  if (viewer.kind === 'solo')   redirect(`/practice?practiceId=${viewer.practiceId}`);

  const setup = await resolveBrandPracticeSetup(s, viewer.practices);

  return (
    <BrandShell
      brandName={viewer.brands[0]?.name ?? null}
      brandCount={viewer.brands.length}
    >
      <header>
        <h2 className="text-lg font-semibold" style={{ color: '#13294B' }}>Practices</h2>
        <p className="text-sm text-gray-500 mt-1">
          Every practice in your brand and how far its setup has got. Open a practice to
          finish anything outstanding.
        </p>
      </header>

      <PracticesTable practices={setup} />
    </BrandShell>
  );
}
