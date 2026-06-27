'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import PlacesAutocomplete from '@/app/_components/PlacesAutocomplete';
import { parseAddressComponents } from '@/lib/maps/places';
import type { CreateBranchInput } from '@/app/brand/actions';

const SPECIALTIES = [
  'General Practice', 'Dentistry', 'Physiotherapy', 'Optometry',
  'Specialist Medicine', 'Psychology', 'Nursing', 'Pharmacy', 'Other',
];

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

type Props = {
  groupId:      string;
  createAction: (input: CreateBranchInput) => Promise<{ branchId: string | null; error: string | null }>;
};

export default function BranchForm({ groupId, createAction }: Props) {
  const [name,      setName]      = useState('');
  const [specialty, setSpecialty] = useState('');
  const [email,     setEmail]     = useState('');
  const [phone,     setPhone]     = useState('');

  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [suburb,       setSuburb]       = useState('');
  const [city,         setCity]         = useState('');
  const [province,     setProvince]     = useState('');
  const [postalCode,   setPostalCode]   = useState('');
  const [latitude,     setLatitude]     = useState<number | null>(null);
  const [longitude,    setLongitude]    = useState<number | null>(null);

  const [isPending, startTransition] = useTransition();
  const [error,     setError]   = useState<string | null>(null);
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !specialty || !email.trim() || !addressLine1 || latitude == null) {
      setError('Name, specialty, email, and a picked address are required.');
      return;
    }
    startTransition(async () => {
      const r = await createAction({
        groupId,
        name, specialty, email,
        phone:        phone.trim() || null,
        addressLine1, addressLine2: addressLine2 || null,
        suburb:       suburb || null,
        city:         city   || null,
        province:     province || null,
        postalCode:   postalCode || null,
        latitude, longitude,
      });
      if (r.error) {
        setError(r.error);
      } else if (r.branchId) {
        router.push('/brand');
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm p-5">
      <input className={inputCls} placeholder="Branch name"           value={name}  onChange={(e) => setName(e.target.value)} />
      <select className={inputCls} value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
        <option value="">Select specialty…</option>
        {SPECIALTIES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <input className={inputCls} placeholder="Email"                 type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className={inputCls} placeholder="Phone (optional)"      value={phone} onChange={(e) => setPhone(e.target.value)} />

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Branch address</label>
        <PlacesAutocomplete
          variant="address"
          placeholder="Start typing the branch address…"
          initialValue={addressLine1}
          onSelect={(place) => {
            const parsed = parseAddressComponents(place.addressComponents);
            setAddressLine1(place.formattedAddress);
            setSuburb(parsed.suburb ?? '');
            setCity(parsed.city ?? '');
            setProvince(parsed.province ?? '');
            setPostalCode(parsed.postalCode ?? '');
            setLatitude(place.latitude);
            setLongitude(place.longitude);
          }}
        />
      </div>

      <input className={inputCls} placeholder="Unit / suite (optional)" value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} />

      {addressLine1 && latitude != null && (
        <p className="text-[11px] text-gray-500">
          Parsed: {[suburb, city, province, postalCode].filter(Boolean).join(' · ') || '—'}
        </p>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={isPending}
        className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {isPending ? 'Creating…' : 'Create branch (pending approval)'}
      </button>
    </form>
  );
}
