'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import PlacesAutocomplete from '@/app/_components/PlacesAutocomplete';
import { parseAddressComponents } from '@/lib/maps/places';
import SpecialtyOptions from '@/components/SpecialtyOptions';
import { createLead } from '../actions';

const SOURCES = ['referral','cold_outreach','inbound','event','other'] as const;

export default function NewLeadForm({
  currentUserId, isAdmin, owners,
}: {
  currentUserId: string;
  isAdmin: boolean;
  owners: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [f, setF] = useState({
    practice_name:              '',
    contact_first_name:         '',
    contact_last_name:          '',
    role_at_practice:           '',
    specialty:                  '',
    phone:                      '',
    email:                      '',
    street_address:             '',
    suburb:                     '',
    city:                       '',
    province:                   '',
    latitude:                   null as number | null,
    longitude:                  null as number | null,
    formatted_address:          '',
    source:                     'other' as (typeof SOURCES)[number],
    estimated_monthly_billings: '',
    owner_user_id:              currentUserId,
  });

  const [dupes, setDupes]     = useState<Array<{ id: string; practice_name: string }>>([]);
  const [error, setError]     = useState<string | null>(null);

  function upd<K extends keyof typeof f>(key: K, value: (typeof f)[K]) {
    setF(prev => ({ ...prev, [key]: value }));
  }

  function submit(confirmDupe: boolean) {
    setError(null);
    startTransition(async () => {
      const res = await createLead({
        practice_name:      f.practice_name,
        contact_first_name: f.contact_first_name,
        contact_last_name:  f.contact_last_name,
        role_at_practice:   f.role_at_practice || null,
        specialty:          f.specialty || null,
        phone:              f.phone || null,
        email:              f.email || null,
        street_address:     f.street_address || null,
        suburb:             f.suburb || null,
        city:               f.city || null,
        province:           f.province || null,
        latitude:           f.latitude,
        longitude:          f.longitude,
        formatted_address:  f.formatted_address || null,
        source:             f.source,
        estimated_monthly_billings: f.estimated_monthly_billings ? Number(f.estimated_monthly_billings) : null,
        owner_user_id:      f.owner_user_id || null,
        confirmDupe,
      });

      if (res.duplicates && res.duplicates.length > 0 && !confirmDupe) {
        setDupes(res.duplicates);
        return;
      }
      if (res.error)  { setError(res.error); return; }
      if (res.leadId) { router.push(`/crm/leads/${res.leadId}`); return; }
    });
  }

  return (
    <form
      className="mt-6 space-y-4"
      onSubmit={e => { e.preventDefault(); submit(false); }}
    >
      <Field label="Practice name" required>
        <input required value={f.practice_name} onChange={e => upd('practice_name', e.target.value)}
          className={inp} />
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Contact first name" required>
          <input required value={f.contact_first_name} onChange={e => upd('contact_first_name', e.target.value)} className={inp} />
        </Field>
        <Field label="Contact last name" required>
          <input required value={f.contact_last_name} onChange={e => upd('contact_last_name', e.target.value)} className={inp} />
        </Field>
        <Field label="Role at practice">
          <input value={f.role_at_practice} onChange={e => upd('role_at_practice', e.target.value)} placeholder="Owner, Practice Manager, Receptionist…" className={inp} />
        </Field>
        <Field label="Specialty">
          <select value={f.specialty} onChange={e => upd('specialty', e.target.value)} className={inp}>
            <SpecialtyOptions placeholder="(none)" />
          </select>
        </Field>
        <Field label="Phone">
          <input value={f.phone} onChange={e => upd('phone', e.target.value)} className={inp} placeholder="+27 …" />
        </Field>
        <Field label="Email">
          <input type="email" value={f.email} onChange={e => upd('email', e.target.value)} className={inp} />
        </Field>
      </div>

      <Field label="Address">
        <PlacesAutocomplete
          variant="address"
          inputId="lead-address"
          placeholder="Start typing — Google Places will suggest matches"
          onSelect={(place) => {
            const parsed = parseAddressComponents(place.addressComponents);
            setF(prev => ({
              ...prev,
              formatted_address: place.formattedAddress,
              street_address:    parsed.addressLine1 ?? place.formattedAddress,
              suburb:            parsed.suburb   ?? prev.suburb,
              city:              parsed.city     ?? prev.city,
              province:          parsed.province ?? prev.province,
              latitude:          place.latitude,
              longitude:         place.longitude,
            }));
          }}
        />
        {f.formatted_address && (
          <p className="mt-1 text-xs text-gray-500">Picked: {f.formatted_address}</p>
        )}
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Source">
          <select value={f.source} onChange={e => upd('source', e.target.value as (typeof SOURCES)[number])} className={inp}>
            {SOURCES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
        </Field>
        <Field label="Estimated monthly billings" hint="ZAR">
          <input
            type="number" min="0" step="1"
            value={f.estimated_monthly_billings}
            onChange={e => upd('estimated_monthly_billings', e.target.value)}
            className={inp}
            placeholder="e.g. 45000"
          />
        </Field>
        {isAdmin ? (
          <Field label="Owner">
            <select value={f.owner_user_id} onChange={e => upd('owner_user_id', e.target.value)} className={inp}>
              {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </Field>
        ) : (
          <Field label="Owner">
            <p className="text-sm text-gray-500 px-3 py-2">You</p>
          </Field>
        )}
      </div>

      {dupes.length > 0 && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 px-3 py-3 text-xs space-y-2">
          <p className="font-semibold">Possible duplicate — matching phone or email:</p>
          <ul className="list-disc pl-5">
            {dupes.map(d => (
              <li key={d.id}><a href={`/crm/leads/${d.id}`} className="underline">{d.practice_name}</a></li>
            ))}
          </ul>
          <p>Two practitioners can share a practice line — but if this is the same practice, open the existing lead instead. Otherwise, confirm and create anyway.</p>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setDupes([])} className="rounded-lg border border-amber-300 bg-white text-amber-900 px-3 py-1.5 text-xs">Back to form</button>
            <button type="button" onClick={() => submit(true)} disabled={pending} className="rounded-lg bg-amber-700 text-white px-3 py-1.5 text-xs font-medium disabled:opacity-60">Create anyway</button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-3 py-2 text-xs">{error}</div>
      )}

      <div className="flex gap-2 justify-end">
        <button type="button" onClick={() => router.push('/crm/leads')} disabled={pending} className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-2 text-sm">Cancel</button>
        <button type="submit" disabled={pending} className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium disabled:opacity-60">
          {pending ? 'Creating…' : 'Create lead'}
        </button>
      </div>
    </form>
  );
}

const inp = 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E]';

function Field({ label, hint, required, children }: {
  label: string; hint?: string; required?: boolean; children: React.ReactNode;
}) {
  return (
    <label className="text-xs block">
      <span className="block font-medium text-gray-700 mb-1">
        {label}{required && <span className="text-red-500"> *</span>}
        {hint && <span className="ml-2 text-gray-400 font-normal">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
