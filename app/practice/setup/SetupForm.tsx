'use client';

import { useState } from 'react';
import SpecialtyOptions from '@/components/SpecialtyOptions';

type PracticeFormData = {
  practiceId: string;
  name: string;
  specialty: string;
  hpcsaNumber: string;
  phone: string;
  bankName: string;
  bankAccountNumber: string;
  branchCode: string;
};

type Props = {
  createPractice: (data: PracticeFormData) => Promise<{ error: string | null }>;
};

export default function SetupForm({ createPractice }: Props) {
  const [name, setName] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [hpcsaNumber, setHpcsaNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [branchCode, setBranchCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // Pre-generate the UUID client-side so we don't need INSERT...RETURNING,
    // which would require a SELECT policy on practices before the member row exists.
    const practiceId = crypto.randomUUID();

    const result = await createPractice({
      practiceId,
      name,
      specialty,
      hpcsaNumber,
      phone,
      bankName,
      bankAccountNumber,
      branchCode,
    });

    if (result.error) {
      setError(result.error);
      setLoading(false);
      return;
    }

    window.location.href = '/practice';
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
      {error && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {/* Practice name */}
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
            Practice name
          </label>
          <input
            id="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="Cape Town Family Practice"
          />
        </div>

        {/* Specialty */}
        <div>
          <label htmlFor="specialty" className="block text-sm font-medium text-gray-700 mb-1">
            Specialty
          </label>
          <select
            id="specialty"
            required
            value={specialty}
            onChange={(e) => setSpecialty(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="" disabled>Select a specialty</option>
            <SpecialtyOptions />
          </select>
        </div>

        {/* HPCSA number */}
        <div>
          <label htmlFor="hpcsa" className="block text-sm font-medium text-gray-700 mb-1">
            HPCSA number
            <span className="ml-1 text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            id="hpcsa"
            type="text"
            value={hpcsaNumber}
            onChange={(e) => setHpcsaNumber(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="MP0000000"
          />
        </div>

        {/* Phone */}
        <div>
          <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
            Practice phone
          </label>
          <input
            id="phone"
            type="text"
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="+27 21 000 0000"
          />
        </div>

        <hr className="border-gray-100" />
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Banking details — for payouts
        </p>

        {/* Bank name */}
        <div>
          <label htmlFor="bankName" className="block text-sm font-medium text-gray-700 mb-1">
            Bank name
          </label>
          <input
            id="bankName"
            type="text"
            required
            value={bankName}
            onChange={(e) => setBankName(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="First National Bank"
          />
        </div>

        {/* Account number + branch code side by side */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="accountNumber" className="block text-sm font-medium text-gray-700 mb-1">
              Account number
            </label>
            <input
              id="accountNumber"
              type="text"
              required
              value={bankAccountNumber}
              onChange={(e) => setBankAccountNumber(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="62000000000"
            />
          </div>
          <div>
            <label htmlFor="branchCode" className="block text-sm font-medium text-gray-700 mb-1">
              Branch code
            </label>
            <input
              id="branchCode"
              type="text"
              required
              value={branchCode}
              onChange={(e) => setBranchCode(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="250655"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[var(--portal-accent)] focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
          style={{ background: 'linear-gradient(135deg, var(--portal-ink) 0%, var(--portal-accent) 145%)' }}
        >
          {loading ? 'Creating practice…' : 'Create practice'}
        </button>
      </form>
    </div>
  );
}
