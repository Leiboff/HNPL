import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import {
  generateDeviceRegistrationCode,
  revokeDevice,
  setTillPin,
  listDevices,
} from './actions';
import DeviceAdminView from './DeviceAdminView';

// ─── /practice/pos/devices — manager-only till administration ─────────────
//
// Ordinary per-user Supabase login, unchanged — this is NOT the
// device-gated model (that's /practice/pos itself). Reachable by either
// a per-practice manager (can_manage_practice) OR a brand-admin of the
// practice's group (practice_group_members) — see guardTillManager in
// ./actions.ts for the authority check itself; this page no longer
// re-implements a narrower practice_members-only gate of its own (it
// used to, which is exactly what made the brand-admin path 404 even
// with a link present — see the entry-point fix that added this
// comment).
//
// Authorization is decided ENTIRELY by listDevices()'s own guard below —
// this page just resolves which practiceId to ask about and redirects
// if that guard rejects. practiceName/hasPin are read via service-role
// once authorized, since a brand-only caller has no practice_members row
// for the authenticated client's RLS to key off.

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

type SearchParams = { practiceId?: string };

export default async function DevicesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  const { user, supabase } = await requireConfirmedUser({ next: '/practice/pos/devices' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'practice_admin' && profile?.role !== 'practice_staff') {
    if (profile?.role === 'patient')  redirect('/patient');
    else if (profile?.role === 'admin') redirect('/admin');
    else redirect('/login');
  }

  // Target practice: an explicit ?practiceId= (how both entry-point
  // links — the single-practice sidebar and the brand branch strip —
  // always reach this page) or, for a direct hit with none, the
  // caller's own first can_manage_practice practice_members row —
  // matching every other /practice/* page's fallback shape. A pure
  // brand-admin with zero practice_members rows anywhere has no
  // meaningful fallback here (there's no "first practice" to guess),
  // so they must arrive via an explicit ?practiceId= link.
  let practiceId = params.practiceId ?? null;
  if (!practiceId) {
    const { data: memberships } = await supabase
      .from('practice_members')
      .select('practice_id')
      .eq('user_id', user.id)
      .eq('active', true)
      .eq('can_manage_practice', true)
      .order('created_at', { ascending: true })
      .limit(1);
    if (!memberships || memberships.length === 0) redirect('/practice');
    practiceId = memberships[0].practice_id as string;
  }

  // The real authorization decision — per-practice manager OR
  // brand-admin of this practice's group. Anyone else is rejected here,
  // before any practice-scoped data is fetched.
  const devicesResult = await listDevices(practiceId);
  if (devicesResult.error) redirect('/practice');

  const s = svc();
  const { data: practice } = await s
    .from('practices')
    .select('name, till_pin_hash')
    .eq('id', practiceId)
    .maybeSingle();
  const practiceName = (practice?.name as string | undefined) ?? 'Practice';

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-3xl px-6 py-4 flex items-center justify-between">
          <div>
            <span className="text-lg font-semibold tracking-tight" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
              <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
            </span>
            <span className="ml-2 text-sm text-gray-400">— {practiceName} · Till devices</span>
          </div>
          <a href={`/practice?practiceId=${practiceId}`} className="text-sm text-[#15A89E] hover:text-[#13294B]">
            ← Back to dashboard
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold text-gray-900">Till devices</h1>
          <p className="mt-2 text-gray-500">
            Register a till PC to issue bills without a personal login, and manage the
            practice&apos;s till PIN.
          </p>
        </div>

        <DeviceAdminView
          practiceId={practiceId}
          initialDevices={devicesResult.devices ?? []}
          hasPin={!!practice?.till_pin_hash}
          generateDeviceRegistrationCode={generateDeviceRegistrationCode}
          revokeDevice={revokeDevice}
          setTillPin={setTillPin}
        />
      </main>
    </div>
  );
}
