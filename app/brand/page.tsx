import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

// ─── Brand-admin dashboard ──────────────────────────────────────────────
//
// Post-0062 every customer account is rooted at a brand. The brand
// concept is HIDDEN at n=1 — the solo practitioner experiences the
// product as "my practice", not "my brand with one practice in it".
// This page enforces that rule:
//
//   n = 0  → /practice/setup (no membership at all — shouldn't happen
//            in practice but we redirect rather than blank-page)
//   n = 1  → /practice (the brand layer is invisible; their one
//            practice IS their experience)
//   n >= 2 → render the brand index — every practice in their brand
//            with a status pill, plus "Add another practice".
//
// The brand row name is shown only when n>=2 (so a solo who ever
// stumbles here doesn't see "Brand X" wording when they're meant to
// see just their own practice).

type GroupRow  = { id: string; name: string };
type BranchRow = {
  id: string; name: string; status: string;
  city: string | null; suburb: string | null;
  group_id: string;
};

export default async function BrandDashboardPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Brand memberships — typically just one (their own auto-created
  // brand from signup) but a user could be brand_admin of multiple
  // brands in theory.
  const { data: memberships } = await supabase
    .from('practice_group_members')
    .select('group_id, active')
    .eq('user_id', user.id)
    .eq('active', true);

  if (!memberships || memberships.length === 0) {
    // No brand_admin row — fall back to their per-practice dashboard.
    redirect('/practice');
  }

  const groupIds = memberships.map((m) => m.group_id as string);

  // All practices in their brand(s). Counting these drives the
  // n=1-vs-n>=2 UX rule below.
  const { data: rawBranches } = await supabase
    .from('practices')
    .select('id, name, status, city, suburb, group_id')
    .in('group_id', groupIds)
    .order('name');
  const branches = (rawBranches ?? []) as BranchRow[];

  if (branches.length === 0) {
    // Brand exists but no practices yet (rare — would only happen if
    // a practice was manually deleted). Send them to setup.
    redirect('/practice/setup');
  }
  if (branches.length === 1) {
    // Solo — keep the brand invisible. Their one practice IS their
    // dashboard.
    redirect(`/practice?practiceId=${branches[0].id}`);
  }

  const { data: rawGroups } = await supabase
    .from('practice_groups')
    .select('id, name')
    .in('id', groupIds);
  const groups = (rawGroups ?? []) as GroupRow[];

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-10 space-y-8">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: '#13294B' }}>My practices</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage every practice you&apos;ve added. New practices go pending — BetterNow approves them before they can trade.
          </p>
        </div>
      </header>

      {/* Quick links — surface the brand-admin's three management
          surfaces: revenue (the new dashboard), brand settings, and
          add-a-practice. Tile layout so each is one tap on mobile. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Link
          href="/brand/revenue"
          className="rounded-xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3 hover:bg-gray-50"
        >
          <p className="text-xs uppercase tracking-widest text-gray-500">Revenue</p>
          <p className="text-sm font-semibold mt-1" style={{ color: '#13294B' }}>Group dashboard</p>
        </Link>
        <Link
          href="/brand/group"
          className="rounded-xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3 hover:bg-gray-50"
        >
          <p className="text-xs uppercase tracking-widest text-gray-500">Brand</p>
          <p className="text-sm font-semibold mt-1" style={{ color: '#13294B' }}>Settings &amp; logo</p>
        </Link>
        <Link
          href="/brand/new-practice"
          className="rounded-xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3 hover:bg-gray-50"
        >
          <p className="text-xs uppercase tracking-widest text-gray-500">Add</p>
          <p className="text-sm font-semibold mt-1" style={{ color: '#13294B' }}>+ Add a practice</p>
        </Link>
      </div>

      {groups.map((g) => {
        const groupBranches = branches.filter((b) => b.group_id === g.id);
        return (
          <section key={g.id} className="space-y-3">
            <h2 className="text-lg font-semibold text-gray-900">{g.name}</h2>

            <div className="space-y-2">
              {groupBranches.map((b) => (
                <div
                  key={b.id}
                  className="rounded-xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 truncate">{b.name}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{[b.suburb, b.city].filter(Boolean).join(', ') || '—'}</p>
                    </div>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      b.status === 'approved'  ? 'bg-green-100 text-green-700' :
                      b.status === 'pending'   ? 'bg-amber-100 text-amber-700' :
                      b.status === 'suspended' ? 'bg-red-100 text-red-700' :
                                                 'bg-gray-100 text-gray-500'
                    }`}>
                      {b.status}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                    <Link
                      href={`/practice?practiceId=${b.id}`}
                      className="font-semibold underline underline-offset-2"
                      style={{ color: '#13294B' }}
                    >
                      Open dashboard →
                    </Link>
                    <Link
                      href={`/brand/branch/${b.id}`}
                      className="font-semibold underline underline-offset-2"
                      style={{ color: '#13294B' }}
                    >
                      Edit details
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
