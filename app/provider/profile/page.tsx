import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { decryptIdForDisplay, maskId } from '@/lib/idEncryption';
import { getRequestUser } from '@/lib/auth/requestUser';

async function updatePhone(phone: string): Promise<{ error: string | null }> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (profile?.role !== 'practice_provider') return { error: 'Unauthorized.' };

  const { error } = await supabase
    .from('profiles')
    .update({ phone: phone.trim() })
    .eq('id', user.id);

  if (error) return { error: error.message };
  revalidatePath('/provider/profile');
  return { error: null };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between py-3 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className="text-sm font-medium text-gray-900 text-right max-w-xs">{value || '—'}</span>
    </div>
  );
}

export default async function ProviderProfilePage() {
  const supabase = await createClient();
  const user = await getRequestUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name, email, phone, hpcsa_number, sa_id_number')
    .eq('id', user.id)
    .single();

  const { data: member } = await supabase
    .from('practice_members')
    .select('specialty, hpcsa_number')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!profile) redirect('/login');

  const plain = decryptIdForDisplay(profile.sa_id_number);
  const saIdMasked = plain ? maskId(plain) : '—';

  return (
    <div className="space-y-8 max-w-lg">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">My Profile</h1>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Personal details</h2>
        <div className="divide-y divide-gray-100">
          <Row label="Name"       value={`${profile.first_name} ${profile.last_name}`} />
          <Row label="Email"      value={profile.email ?? ''} />
          <Row label="Specialty"  value={member?.specialty ?? ''} />
          <Row label="HPCSA No."  value={member?.hpcsa_number ?? profile.hpcsa_number ?? ''} />
          <Row label="SA ID"      value={saIdMasked} />
        </div>
      </div>

      {/* This card used to read "Your personal account (•••• 1234)" for a
          doctor whose membership elected payout_destination='provider'. That
          option is gone — every plan now pays into the practice's own bank
          account so a practice can reconcile one weekly deposit against one
          batch (migration 0090).

          The card stays rather than disappearing: a doctor who previously saw
          their own account here would otherwise be left wondering where the
          setting went, and "where does my money go" is a reasonable question
          to be able to answer on your own profile. It now states the single
          rule plainly and says who to ask. */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">How you get paid</h2>
        <p className="text-sm text-gray-900" data-testid="provider-payout-destination">
          Into your practice&apos;s bank account.
        </p>
        <p className="mt-2 text-xs text-gray-500">
          BetterNow pays each practice once a week for the plans activated that week,
          and the practice pays its practitioners. Your practice admin can confirm the
          arrangement and the banking details on file.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Phone number</h2>
        <form
          action={async (formData: FormData) => {
            'use server';
            await updatePhone(formData.get('phone') as string ?? '');
          }}
          className="flex gap-3"
        >
          <input
            name="phone"
            type="tel"
            defaultValue={profile.phone ?? ''}
            placeholder="082 000 0000"
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-[#0F4C75] focus:outline-none focus:ring-1 focus:ring-[#0F4C75]"
          />
          <button
            type="submit"
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors"
            style={{ backgroundColor: '#0F4C75' }}
          >
            Save
          </button>
        </form>
      </div>
    </div>
  );
}
