import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import LogoutButton from '@/app/dashboard/LogoutButton';
import PracticeApprovalRow, { type PracticeRow } from './PracticeApprovalRow';
import { approvePractice, suspendPractice } from './actions';

type SearchParams = { status?: string };

const STATUS_OPTIONS = ['pending', 'approved', 'suspended', 'inactive'] as const;
type StatusFilter = typeof STATUS_OPTIONS[number];

function parseStatus(raw: string | undefined): StatusFilter {
  return (STATUS_OPTIONS as readonly string[]).includes(raw ?? '')
    ? (raw as StatusFilter)
    : 'pending';
}

export default async function AdminPracticesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin/practices' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                            redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                             redirect('/provider');
    else                                                                        redirect('/login');
  }

  const params = await searchParams;
  const status = parseStatus(params.status);

  // ── Practices in this status bucket ────────────────────────────────────
  // Fields needed by the row component to drive an approve decision:
  //   • identity / address / PR / HPCSA — straight from practices
  //   • banking complete? — bank_name + bank_account_number both present
  //   • approved_at / approved_by — for the "Approved by" column when
  //     looking at approved practices
  const { data: rawPractices } = await supabase
    .from('practices')
    .select(`
      id, name, specialty, status,
      practice_registration_number, hpcsa_number,
      email, phone,
      address_line1, address_line2, suburb, city, practice_province, postal_code,
      bank_name, bank_account_number, branch_code,
      created_at, approved_at, approved_by
    `)
    .eq('status', status)
    .order('created_at', { ascending: false });

  const practices = (rawPractices ?? []) as PracticeRow[];

  // ── Per-practice aggregates (providers count, HPCSAs across members) ────
  // One round-trip for every visible practice. Acceptable at admin
  // volume; if the pending queue grows past a few dozen we can swap to
  // a single grouped query.
  const aggregates: Record<string, { providerCount: number; memberHpcsas: string[] }> = {};
  for (const p of practices) {
    const { data: rows } = await supabase
      .from('practice_members')
      .select('role, hpcsa_number, active')
      .eq('practice_id', p.id)
      .eq('active', true);
    const memberRows = (rows ?? []) as Array<{ role: string; hpcsa_number: string | null; active: boolean }>;
    aggregates[p.id] = {
      providerCount: memberRows.filter(r => r.role === 'provider').length,
      memberHpcsas:  memberRows.map(r => r.hpcsa_number).filter((h): h is string => !!h),
    };
  }

  // ── Status-bucket counts for the filter chips ──────────────────────────
  const { data: countsRaw } = await supabase
    .from('practices')
    .select('status');
  const counts: Record<StatusFilter, number> = { pending: 0, approved: 0, suspended: 0, inactive: 0 };
  for (const row of (countsRaw ?? []) as Array<{ status: string }>) {
    if ((STATUS_OPTIONS as readonly string[]).includes(row.status)) {
      counts[row.status as StatusFilter] = (counts[row.status as StatusFilter] ?? 0) + 1;
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <div>
            <span className="text-lg font-semibold tracking-tight" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
              <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
            </span>
            <span className="ml-2 text-sm text-gray-400">— Admin</span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/admin" className="text-sm text-[#15A89E] hover:text-[#13294B]">
              ← Operations
            </Link>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Practice approvals</h1>
          <p className="mt-1 text-sm text-gray-500">
            Review and approve practice signups. Approval flips practices.status to <code>approved</code> and
            opens the trading gate as soon as the practice also has at least one active provider.
          </p>
        </div>

        {/* Filter chips */}
        <div className="flex gap-2 flex-wrap">
          {STATUS_OPTIONS.map((s) => {
            const active = s === status;
            return (
              <Link
                key={s}
                href={`/admin/practices?status=${s}`}
                className={
                  'rounded-full px-3 py-1.5 text-sm font-medium border transition-colors '
                  + (active
                    ? 'border-[#15A89E] bg-[#15A89E]/10 text-[#15A89E]'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300')
                }
              >
                {s.charAt(0).toUpperCase() + s.slice(1)} ({counts[s]})
              </Link>
            );
          })}
        </div>

        {/* Practice list */}
        {practices.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
            <p className="text-gray-500">No practices with status <strong>{status}</strong>.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {practices.map((p) => (
              <PracticeApprovalRow
                key={p.id}
                practice={p}
                providerCount={aggregates[p.id]?.providerCount ?? 0}
                memberHpcsas={aggregates[p.id]?.memberHpcsas ?? []}
                approvePractice={approvePractice}
                suspendPractice={suspendPractice}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
