import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createBranch } from '@/app/brand/actions';
import BranchForm from '@/app/brand/[groupId]/new-branch/BranchForm';

// ─── Brand-owner self-service: add another practice ─────────────────────
//
// Post-0062 every customer account is rooted at a brand. The brand is
// invisible at n=1 (solo), so the solo practitioner reaches this page
// via the "+ Add another practice" link on their /practice dashboard
// and never sees the word "brand" or "group".
//
// The route resolves the user's own brand_admin membership and renders
// the same BranchForm the platform-admin / brand-admin uses behind the
// scenes. Same createBranch action, same status='pending' guarantee.
//
// At n=1 we drop the "brand X" wording; at n>=2 (multi-branch) we
// surface the brand name so the user knows which brand they're adding
// to (relevant only if they're brand_admin of multiple brands, which
// is the rare support case).

export default async function NewPracticeForOwnBrandPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: memberships } = await supabase
    .from('practice_group_members')
    .select('group_id, practice_groups(name)')
    .eq('user_id', user.id)
    .eq('active', true);

  // Same to-one-as-array typegen quirk as /practice/page.tsx —
  // normalise to the shape we want.
  const rowsRaw = (memberships ?? []) as unknown as Array<{
    group_id: string;
    practice_groups: { name: string } | Array<{ name: string }> | null;
  }>;
  const rows = rowsRaw.map((r) => ({
    group_id: r.group_id,
    practice_groups: Array.isArray(r.practice_groups)
      ? (r.practice_groups[0] ?? null)
      : r.practice_groups,
  }));

  if (rows.length === 0) {
    // No brand_admin row — shouldn't happen for a post-0062 signup,
    // but be safe: punt them back to /practice (which itself routes
    // to /practice/setup if they have no practice either).
    redirect('/practice');
  }

  // Pick the first brand. A user with multiple brand_admin rows is
  // a rare support case; if it becomes common we'll add a picker.
  const groupId   = rows[0].group_id;
  const groupName = rows[0].practice_groups?.name ?? null;

  // Count practices in this brand — drives the n=1 wording rule.
  const { count: practiceCount } = await supabase
    .from('practices')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId);

  const isSolo = (practiceCount ?? 0) <= 1;

  return (
    <div className="mx-auto max-w-xl px-4 sm:px-6 py-6 sm:py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--portal-ink)' }}>
          {isSolo ? 'Add another practice' : `Add a practice to ${groupName ?? 'your brand'}`}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          The new practice will be created in <strong>pending</strong> status. BetterNow approves it before it can trade.
        </p>
      </header>

      <BranchForm groupId={groupId} createAction={createBranch} />
    </div>
  );
}
