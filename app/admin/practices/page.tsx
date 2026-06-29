import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
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
  //   • group_id + brand context — post-0062 every practice belongs to
  //     a brand. A SOLO brand (1 practice) is treated like the old
  //     "standalone" — no brand chip shown. A MULTI brand (≥2) shows a
  //     "Brand: X · n of m" chip so the admin sees that this approval
  //     creates a new location under an existing customer.
  const { data: rawPractices } = await supabase
    .from('practices')
    .select(`
      id, name, specialty, status, group_id,
      practice_registration_number, hpcsa_number,
      email, phone,
      address_line1, address_line2, suburb, city, practice_province, postal_code,
      bank_name, bank_account_number, branch_code,
      created_at, approved_at, approved_by
    `)
    .eq('status', status)
    .order('created_at', { ascending: false });

  type PracticeWithGroup = PracticeRow & { group_id: string | null };
  const practices = (rawPractices ?? []) as PracticeWithGroup[];

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

  // ── Brand context: name + sibling count per practice ───────────────────
  // For each unique group_id in the visible list, fetch the brand row
  // and the count of practices under it. We only surface "brand" wording
  // when the brand has >=2 practices — a solo brand is invisible
  // (matches the brand-first UX rule: brand hidden at n=1).
  const uniqueGroupIds = Array.from(
    new Set(practices.map(p => p.group_id).filter((g): g is string => !!g))
  );
  const brandContext: Record<string, { brandName: string; siblingCount: number }> = {};
  for (const gid of uniqueGroupIds) {
    const [{ data: groupRow }, { count: practiceCount }] = await Promise.all([
      supabase.from('practice_groups').select('name').eq('id', gid).maybeSingle(),
      supabase.from('practices')
        .select('id', { count: 'exact', head: true })
        .eq('group_id', gid),
    ]);
    brandContext[gid] = {
      brandName:    (groupRow?.name as string | undefined) ?? '—',
      siblingCount: practiceCount ?? 0,
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
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Practice approvals</h1>
        <p className="mt-1 text-sm text-gray-500">
          Review and approve practice signups. Approval flips <code>practices.status</code> to <code>approved</code>;
          the trading gate opens once the practice also has at least one active provider.
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
            {practices.map((p) => {
              const ctx = p.group_id ? brandContext[p.group_id] : null;
              const showBrand = !!(ctx && ctx.siblingCount >= 2);
              return (
                <PracticeApprovalRow
                  key={p.id}
                  practice={p}
                  providerCount={aggregates[p.id]?.providerCount ?? 0}
                  memberHpcsas={aggregates[p.id]?.memberHpcsas ?? []}
                  brand={showBrand && ctx ? { name: ctx.brandName, siblingCount: ctx.siblingCount } : null}
                  approvePractice={approvePractice}
                  suspendPractice={suspendPractice}
                />
              );
            })}
          </div>
        )}
    </div>
  );
}
