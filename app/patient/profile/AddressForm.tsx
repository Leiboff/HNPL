'use client';

import { useState } from 'react';

const PROVINCES = [
  'Eastern Cape',
  'Free State',
  'Gauteng',
  'KwaZulu-Natal',
  'Limpopo',
  'Mpumalanga',
  'North West',
  'Northern Cape',
  'Western Cape',
] as const;

type AddressData = {
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  suburb: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
};

type Props = {
  current: AddressData;
  updateProfile: (data: AddressData) => Promise<{ error: string | null }>;
};

function Field({
  id,
  label,
  optional,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {optional && <span className="ml-1 font-normal text-gray-400">(optional)</span>}
      </label>
      {children}
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

export default function AddressForm({ current, updateProfile }: Props) {
  const [phone, setPhone]               = useState(current.phone         ?? '');
  const [line1, setLine1]               = useState(current.address_line1  ?? '');
  const [line2, setLine2]               = useState(current.address_line2  ?? '');
  const [suburb, setSuburb]             = useState(current.suburb         ?? '');
  const [city, setCity]                 = useState(current.city           ?? '');
  const [province, setProvince]         = useState(current.province       ?? '');
  const [postalCode, setPostalCode]     = useState(current.postal_code    ?? '');
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [success, setSuccess]           = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setLoading(true);

    const result = await updateProfile({
      phone:        phone.trim()      || null,
      address_line1: line1.trim()     || null,
      address_line2: line2.trim()     || null,
      suburb:        suburb.trim()    || null,
      city:          city.trim()      || null,
      province:      province         || null,
      postal_code:   postalCode.trim() || null,
    });

    if (result.error) {
      setError(result.error);
    } else {
      setSuccess(true);
    }
    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Phone */}
      <Field id="phone" label="Phone number" optional>
        <input
          id="phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="e.g. 082 000 0000"
          className={inputCls}
        />
      </Field>

      {/* Address line 1 */}
      <Field id="line1" label="Address line 1">
        <input
          id="line1"
          type="text"
          value={line1}
          onChange={(e) => setLine1(e.target.value)}
          placeholder="Street address"
          className={inputCls}
        />
      </Field>

      {/* Address line 2 */}
      <Field id="line2" label="Address line 2" optional>
        <input
          id="line2"
          type="text"
          value={line2}
          onChange={(e) => setLine2(e.target.value)}
          placeholder="Apartment, unit, complex, etc."
          className={inputCls}
        />
      </Field>

      {/* Suburb + City */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <Field id="suburb" label="Suburb">
          <input
            id="suburb"
            type="text"
            value={suburb}
            onChange={(e) => setSuburb(e.target.value)}
            placeholder="e.g. Rosebank"
            className={inputCls}
          />
        </Field>
        <Field id="city" label="City">
          <input
            id="city"
            type="text"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="e.g. Johannesburg"
            className={inputCls}
          />
        </Field>
      </div>

      {/* Province + Postal code */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <Field id="province" label="Province">
          <select
            id="province"
            value={province}
            onChange={(e) => setProvince(e.target.value)}
            className={inputCls}
          >
            <option value="">Select a province</option>
            {PROVINCES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Field id="postalCode" label="Postal code">
          <input
            id="postalCode"
            type="text"
            inputMode="numeric"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            placeholder="e.g. 2196"
            maxLength={6}
            className={inputCls}
          />
        </Field>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
          Profile updated successfully.
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}
