import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import AddressForm from './AddressForm';

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_PROVINCES = new Set([
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal',
  'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape',
]);

// ─── Server Action ────────────────────────────────────────────────────────────

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

  if (data.postal_code) {
    if (!/^\d{4,6}$/.test(data.postal_code)) {
      return { error: 'Postal code must be 4–6 digits.' };
    }
  }

  if (data.province && !VALID_PROVINCES.has(data.province)) {
    return { error: 'Please select a valid South African province.' };
  }

  const { error } = await supabase
    .from('profiles')
    .update({
      phone:          data.phone,
      address_line1:  data.address_line1,
      address_line2:  data.address_line2,
      suburb:         data.suburb,
      city:           data.city,
      province:       data.province,
      postal_code:    data.postal_code,
      // first_name, last_name, sa_id_number, email, role — never touched here
    })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient/profile');
  return { error: null };
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function LockIcon() {
  return (
    <svg
      className="w-3.5 h-3.5 text-gray-400 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25z"
      />
    </svg>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-sm text-gray-700">{value}</p>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function ProfilePage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name, email, phone, sa_id_number, address_line1, address_line2, suburb, city, province, postal_code')
    .eq('id', user.id)
    .single();

  const addressCurrent = {
    phone:          profile?.phone          ?? null,
    address_line1:  profile?.address_line1  ?? null,
    address_line2:  profile?.address_line2  ?? null,
    suburb:         profile?.suburb         ?? null,
    city:           profile?.city           ?? null,
    province:       profile?.province       ?? null,
    postal_code:    profile?.postal_code    ?? null,
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Profile</h1>
        <p className="mt-1 text-sm text-gray-500">
          Manage your contact details and billing address.
        </p>
      </div>

      {/* ── Section 1: Identity (locked) ── */}
      <div className="bg-gray-50 border border-gray-200 rounded-2xl p-6 space-y-5">
        <div className="flex items-center gap-1.5">
          <LockIcon />
          <h2 className="text-sm font-semibold text-gray-600">Identity</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
          <ReadOnlyField label="First name"   value={profile?.first_name   ?? '—'} />
          <ReadOnlyField label="Last name"    value={profile?.last_name    ?? '—'} />
          <ReadOnlyField label="SA ID number" value={profile?.sa_id_number ?? '—'} />
          <ReadOnlyField label="Email"        value={profile?.email        ?? '—'} />
        </div>

        <p className="text-xs text-gray-400 border-t border-gray-200 pt-4">
          Your name and ID number are locked for security. Contact{' '}
          <a
            href="mailto:support@hnpl.co.za"
            className="underline underline-offset-2 hover:text-gray-600 transition-colors"
          >
            support
          </a>{' '}
          if these need to change.
        </p>
      </div>

      {/* ── Section 2: Contact & Billing Address (editable) ── */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 space-y-5">
        <h2 className="text-sm font-semibold text-gray-900">Contact & Billing Address</h2>
        <AddressForm current={addressCurrent} updateProfile={updateProfile} />
      </div>
    </div>
  );
}
