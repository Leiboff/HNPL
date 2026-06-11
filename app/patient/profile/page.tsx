import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import AddressForm from './AddressForm';
import SignOutButton from './SignOutButton';
import PasskeysSection from './PasskeysSection';
import { decryptIdForDisplay } from '@/lib/idEncryption';

const VALID_PROVINCES = new Set([
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal',
  'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape',
]);

async function updateProfile(data: {
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  suburb: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
}): Promise<{ error: string | null }> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  if (data.postal_code && !/^\d{4,6}$/.test(data.postal_code)) {
    return { error: 'Postal code must be 4–6 digits.' };
  }
  if (data.province && !VALID_PROVINCES.has(data.province)) {
    return { error: 'Please select a valid South African province.' };
  }

  const { error } = await supabase
    .from('profiles')
    .update({
      phone:         data.phone,
      address_line1: data.address_line1,
      address_line2: data.address_line2,
      suburb:        data.suburb,
      city:          data.city,
      province:      data.province,
      postal_code:   data.postal_code,
    })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient/profile');
  return { error: null };
}

function LockIcon() {
  return (
    <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25z" />
    </svg>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#13294B', opacity: 0.45 }}>{label}</p>
      <p className="text-sm font-medium text-gray-800">{value || '—'}</p>
    </div>
  );
}

export default async function ProfilePage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name, email, phone, sa_id_number, address_line1, address_line2, suburb, city, province, postal_code')
    .eq('id', user.id)
    .single();

  const decryptedSaId = decryptIdForDisplay(profile?.sa_id_number);

  const firstName = profile?.first_name ?? '';
  const lastName  = profile?.last_name  ?? '';
  const fullName  = [firstName, lastName].filter(Boolean).join(' ');
  const initials  = [firstName[0], lastName[0]].filter(Boolean).join('').toUpperCase() || '?';

  const addressCurrent = {
    phone:         profile?.phone         ?? null,
    address_line1: profile?.address_line1 ?? null,
    address_line2: profile?.address_line2 ?? null,
    suburb:        profile?.suburb        ?? null,
    city:          profile?.city          ?? null,
    province:      profile?.province      ?? null,
    postal_code:   profile?.postal_code   ?? null,
  };

  const card = 'bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm';

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-5 py-6 sm:py-8 space-y-4">

      {/* ── Identity hero ─────────────────────────────────────── */}
      <div className={`${card} p-5 flex items-center gap-4`}>
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center shrink-0 text-white text-lg font-bold select-none"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {initials}
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 truncate">{fullName || '—'}</p>
          <p className="text-sm text-gray-500 truncate mt-0.5">{profile?.email ?? ''}</p>
        </div>
      </div>

      {/* ── Locked identity ────────────────────────────────────── */}
      <div className={`${card} p-5 space-y-4`}>
        <div className="flex items-center gap-1.5" style={{ color: '#13294B', opacity: 0.45 }}>
          <LockIcon />
          <p className="text-[11px] font-semibold uppercase tracking-widest">Identity — read only</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
          <ReadOnlyField label="First name"   value={firstName} />
          <ReadOnlyField label="Last name"    value={lastName} />
          <ReadOnlyField label="SA ID number" value={decryptedSaId || ''} />
          <ReadOnlyField label="Email"        value={profile?.email ?? ''} />
        </div>
        <p className="text-xs text-gray-400 border-t border-gray-100 pt-4">
          Name and ID are locked for security.{' '}
          <a href="mailto:support@betternow.co.za" className="underline underline-offset-2 hover:text-gray-600 transition-colors">
            Contact support
          </a>{' '}
          if these need to change.
        </p>
      </div>

      {/* ── Contact & billing address ──────────────────────────── */}
      <div className={`${card} p-5 space-y-4`}>
        <p className="text-sm font-semibold" style={{ color: '#13294B' }}>Contact &amp; billing address</p>
        <AddressForm current={addressCurrent} updateProfile={updateProfile} />
      </div>

      {/* ── Passkeys ───────────────────────────────────────────── */}
      <div className={`${card} p-5 space-y-4`}>
        <p className="text-sm font-semibold" style={{ color: '#13294B' }}>Passkeys</p>
        <PasskeysSection />
      </div>

      {/* ── Account ───────────────────────────────────────────── */}
      <div className={`${card} p-2`}>
        <SignOutButton />
      </div>

    </div>
  );
}
