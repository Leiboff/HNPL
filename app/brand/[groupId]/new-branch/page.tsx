import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createBranch } from '@/app/brand/actions';
import BranchForm from './BranchForm';

// Brand-admin creates a new branch under their group. Branch is created
// pending — platform-admin approves via the existing path. Brand-admin
// cannot self-approve (0054 column lock blocks any non-service-role
// UPDATE to status).

export default async function NewBranchPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Brand-admin gate. RLS would already restrict, but explicit is better.
  const { data: membership } = await supabase
    .from('practice_group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .eq('user_id', user.id)
    .eq('active', true)
    .maybeSingle();
  if (!membership) notFound();

  const { data: group } = await supabase
    .from('practice_groups')
    .select('id, name')
    .eq('id', groupId)
    .maybeSingle();
  if (!group) notFound();

  return (
    <div className="mx-auto max-w-xl px-4 sm:px-6 py-6 sm:py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold" style={{ color: '#13294B' }}>
          Add a practice to {group.name as string}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          The practice will be created in <strong>pending</strong> status. BetterNow approves it before it can trade.
        </p>
      </header>

      <BranchForm groupId={groupId} createAction={createBranch} />
    </div>
  );
}
