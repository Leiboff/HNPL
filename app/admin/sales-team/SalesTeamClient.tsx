'use client';

import { useState, useTransition } from 'react';
import { grantSalesRole, revokeSalesRole } from './actions';

type SalesRow = {
  id:        string;
  name:      string;
  email:     string;
  createdAt: string;
};

export default function SalesTeamClient({ existing }: { existing: SalesRow[] }) {
  const [email, setEmail]       = useState('');
  const [msg,   setMsg]         = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submitGrant(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const res = await grantSalesRole(email);
      if (res.error) {
        setMsg({ kind: 'err', text: res.error });
      } else {
        setMsg({ kind: 'ok', text: `Granted sales role to ${res.granted?.email}.` });
        setEmail('');
      }
    });
  }

  function submitRevoke(id: string, name: string) {
    if (!confirm(`Revoke sales role for ${name}? They'll lose CRM access immediately.`)) return;
    startTransition(async () => {
      const res = await revokeSalesRole(id);
      if (res.error) setMsg({ kind: 'err', text: res.error });
      else           setMsg({ kind: 'ok',  text: `Revoked sales role.` });
    });
  }

  return (
    <div className="space-y-6">

      {/* ── Grant form ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-900">Grant sales role</h2>
        <form onSubmit={submitGrant} className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            placeholder="user@example.com"
            className="w-full sm:w-96 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E]"
          />
          <button
            type="submit"
            disabled={pending || !email}
            className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            {pending ? 'Granting…' : 'Grant sales role'}
          </button>
        </form>
        {msg && (
          <p
            role="alert"
            className={`text-xs rounded-lg px-3 py-2 ${
              msg.kind === 'ok'
                ? 'border border-green-200 bg-green-50 text-green-800'
                : 'border border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {msg.text}
          </p>
        )}
      </div>

      {/* ── Existing sales users ───────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900">
            Current sales team ({existing.length})
          </h2>
        </div>
        {existing.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-500">
            No one has the sales role yet. Grant it above.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Name', 'Email', 'Signed up', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {existing.map(u => (
                  <tr key={u.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900 font-medium">{u.name}</td>
                    <td className="px-4 py-3 text-gray-600 text-xs">{u.email}</td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{u.createdAt}</td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => submitRevoke(u.id, u.name)}
                        className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-60"
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
