import { redirect } from 'next/navigation';
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
// device-gated model (that's /practice/pos itself). Same auth model as
// every other manager screen in this codebase: requireConfirmedUser +
// can_manage_practice. A biller who cannot manage the practice cannot
// reach this page.

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

  const { data: rawMemberships } = await supabase
    .from('practice_members')
    .select('practice_id, can_manage_practice, created_at, practices(name)')
    .eq('user_id', user.id)
    .eq('active', true)
    .order('created_at', { ascending: true });

  const memberRowsRaw = (rawMemberships ?? []) as unknown as Array<{
    practice_id:         string;
    can_manage_practice: boolean | null;
    created_at:          string;
    practices:           { name: string } | { name: string }[] | null;
  }>;
  const memberRows = memberRowsRaw.map((m) => ({
    ...m,
    practices: Array.isArray(m.practices) ? (m.practices[0] ?? null) : m.practices,
  }));

  if (memberRows.length === 0) redirect('/practice');

  const requestedId = params.practiceId;
  const picked =
    (requestedId && memberRows.find((m) => m.practice_id === requestedId)) ||
    memberRows[0];

  if (!picked.can_manage_practice) {
    redirect(`/practice?practiceId=${picked.practice_id}`);
  }

  const practiceId   = picked.practice_id;
  const practiceName = picked.practices?.name ?? 'Practice';

  const [devicesResult, pinResult] = await Promise.all([
    listDevices(practiceId),
    supabase.from('practices').select('till_pin_hash').eq('id', practiceId).maybeSingle(),
  ]);

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
          hasPin={!!pinResult.data?.till_pin_hash}
          generateDeviceRegistrationCode={generateDeviceRegistrationCode}
          revokeDevice={revokeDevice}
          setTillPin={setTillPin}
        />
      </main>
    </div>
  );
}
