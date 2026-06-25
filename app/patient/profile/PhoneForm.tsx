'use client';

import { useState } from 'react';

// Phone-only editor. Was previously bundled with the physical-address
// fields in AddressForm; those columns are dropped by migration 0059
// for POPIA minimisation (HNPL is a payment product, no delivery), so
// this component now stands alone. Phone stays editable because it's
// load-bearing for OTP and notifications.

type PhoneData = { phone: string | null };

type Props = {
  current: PhoneData;
  updateProfile: (data: PhoneData) => Promise<{ error: string | null }>;
};

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

export default function PhoneForm({ current, updateProfile }: Props) {
  const [phone, setPhone]     = useState(current.phone ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setLoading(true);

    const result = await updateProfile({ phone: phone.trim() || null });

    if (result.error) setError(result.error);
    else              setSuccess(true);
    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
          Phone number
          <span className="ml-1 font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id="phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="e.g. 082 000 0000"
          className={inputCls}
        />
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
          Phone number updated.
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="rounded-lg px-5 py-2.5 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {loading ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
