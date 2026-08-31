'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import PlacesAutocomplete from '@/app/_components/PlacesAutocomplete';
import { parseAddressComponents } from '@/lib/maps/places';
import type { UpdateBranchDetailsInput } from '@/app/brand/actions';

type Initial = {
  name:          string;
  phone:         string | null;
  addressLine1:  string;
  addressLine2:  string | null;
  suburb:        string | null;
  city:          string | null;
  province:      string | null;
  postalCode:    string | null;
  latitude:      number | null;
  longitude:     number | null;
};

type Props = {
  practiceId:  string;
  initial:     Initial;
  saveAction:  (input: UpdateBranchDetailsInput) => Promise<{ error: string | null }>;
};

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[var(--portal-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--portal-accent)]';

export default function BranchDetailsForm({ practiceId, initial, saveAction }: Props) {
  const [editing, setEditing] = useState(false);
  const [name,    setName]    = useState(initial.name);
  const [phone,   setPhone]   = useState(initial.phone ?? '');

  const [addressLine1, setAddressLine1] = useState(initial.addressLine1);
  const [addressLine2, setAddressLine2] = useState(initial.addressLine2 ?? '');
  const [suburb,       setSuburb]       = useState(initial.suburb     ?? '');
  const [city,         setCity]         = useState(initial.city       ?? '');
  const [province,     setProvince]     = useState(initial.province   ?? '');
  const [postalCode,   setPostalCode]   = useState(initial.postalCode ?? '');
  const [latitude,     setLatitude]     = useState<number | null>(initial.latitude);
  const [longitude,    setLongitude]    = useState<number | null>(initial.longitude);

  const [error,   setError]   = useState<string | null>(null);
  const [okMsg,   setOkMsg]   = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function reset() {
    setName(initial.name);
    setPhone(initial.phone ?? '');
    setAddressLine1(initial.addressLine1);
    setAddressLine2(initial.addressLine2 ?? '');
    setSuburb(initial.suburb ?? '');
    setCity(initial.city ?? '');
    setProvince(initial.province ?? '');
    setPostalCode(initial.postalCode ?? '');
    setLatitude(initial.latitude);
    setLongitude(initial.longitude);
    setError(null);
    setOkMsg(null);
    setEditing(false);
  }

  function onSave() {
    setError(null);
    setOkMsg(null);
    if (!name.trim())         { setError('Practice name is required.'); return; }
    if (!addressLine1.trim()) { setError('Address is required.'); return; }

    startTransition(async () => {
      const r = await saveAction({
        practiceId,
        name,
        phone:        phone.trim() || null,
        addressLine1,
        addressLine2: addressLine2 || null,
        suburb:       suburb       || null,
        city:         city         || null,
        province:     province     || null,
        postalCode:   postalCode   || null,
        latitude, longitude,
      });
      if (r.error) setError(r.error);
      else {
        setOkMsg('Saved.');
        setEditing(false);
        router.refresh();
      }
    });
  }

  const locationLine = [suburb, city, province, postalCode].filter(Boolean).join(' · ');

  return (
    <section className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--portal-ink)' }}>Practice details</h2>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            data-testid="branch-details-edit"
            className="text-xs font-semibold underline underline-offset-2"
            style={{ color: 'var(--portal-ink)' }}
          >
            Edit
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={isPending}
              className="text-xs text-gray-500 hover:underline disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={isPending}
              data-testid="branch-details-save"
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, var(--portal-ink) 0%, var(--portal-accent) 145%)' }}
            >
              {isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <Field label="Practice name">
          {editing
            ? <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
            : <p className="text-sm text-gray-900">{name || '—'}</p>}
        </Field>

        <Field label="Phone">
          {editing
            ? <input className={inputCls} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            : <p className="text-sm text-gray-900">{phone || '—'}</p>}
        </Field>

        <Field label="Address">
          {editing ? (
            <div className="space-y-2">
              <PlacesAutocomplete
                variant="address"
                placeholder="Re-pick the address from the suggestions…"
                initialValue={addressLine1}
                onSelect={(place) => {
                  const parsed = parseAddressComponents(place.addressComponents);
                  setAddressLine1(place.formattedAddress);
                  setSuburb(parsed.suburb       ?? '');
                  setCity(parsed.city           ?? '');
                  setProvince(parsed.province   ?? '');
                  setPostalCode(parsed.postalCode ?? '');
                  setLatitude(place.latitude);
                  setLongitude(place.longitude);
                }}
              />
              <input
                className={inputCls}
                placeholder="Unit / suite (optional)"
                value={addressLine2}
                onChange={(e) => setAddressLine2(e.target.value)}
              />
              {locationLine && <p className="text-[11px] text-gray-500">Parsed: {locationLine}</p>}
            </div>
          ) : (
            <div>
              <p className="text-sm text-gray-900 whitespace-pre-wrap">{addressLine1 || '—'}</p>
              {locationLine && <p className="text-xs text-gray-500 mt-0.5">{locationLine}</p>}
            </div>
          )}
        </Field>
      </div>

      {error && <p className="text-xs text-red-700">{error}</p>}
      {okMsg && <p className="text-xs text-emerald-700">{okMsg}</p>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}
