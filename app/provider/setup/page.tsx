'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type State = 'loading' | 'form' | 'done' | 'expired';

export default function ProviderSetupPage() {
  const [state,       setState]       = useState<State>('loading');
  const [practiceName, setPracticeName] = useState<string | null>(null);
  const [password,    setPassword]    = useState('');
  const [confirm,     setConfirm]     = useState('');
  const [error,       setError]       = useState<string | null>(null);
  const [saving,      setSaving]      = useState(false);

  useEffect(() => {
    async function init() {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        setState('expired');
        return;
      }

      // Fetch practice name for the welcome message
      const { data: member } = await supabase
        .from('practice_members')
        .select('practices(name)')
        .eq('user_id', user.id)
        .maybeSingle();

      const practice = member?.practices as unknown as { name: string } | null;
      setPracticeName(practice?.name ?? null);
      setState('form');
    }
    init();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (password.length < 8)  { setError('Password must be at least 8 characters.'); return; }

    setError(null);
    setSaving(true);
    const supabase = createClient();

    const { error: updateErr } = await supabase.auth.updateUser({ password });
    if (updateErr) {
      setError(updateErr.message);
      setSaving(false);
      return;
    }

    // Clear must_change_password flag
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase
        .from('profiles')
        .update({ must_change_password: false })
        .eq('id', user.id);
    }

    setSaving(false);
    setState('done');
    setTimeout(() => { window.location.href = '/provider'; }, 1500);
  }

  const INPUT = 'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-[#0F4C75] focus:outline-none focus:ring-1 focus:ring-[#0F4C75]';

  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-sm text-gray-400">Verifying invite link…</div>
      </div>
    );
  }

  if (state === 'expired') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="max-w-sm text-center">
          <div className="text-4xl mb-4">🔗</div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">Invite link expired</h1>
          <p className="text-sm text-gray-500">
            This invite link has expired or is invalid. Please ask your practice admin to resend your invitation.
          </p>
        </div>
      </div>
    );
  }

  if (state === 'done') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
            <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-gray-900">Password set</h1>
          <p className="mt-2 text-sm text-gray-500">Redirecting to your dashboard…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
        <div className="mb-7">
          <span className="text-lg font-bold" style={{ color: '#0F4C75' }}>BetterNow</span>
          <h1 className="mt-3 text-2xl font-semibold text-gray-900">Set your password</h1>
          {practiceName && (
            <p className="mt-1 text-sm text-gray-500">
              You&apos;ve been invited to BetterNow by <span className="font-medium text-gray-700">{practiceName}</span>.
            </p>
          )}
        </div>

        {error && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New password</label>
            <input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" className={INPUT} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Confirm password</label>
            <input type="password" autoComplete="new-password" required minLength={8} value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Repeat password" className={INPUT} />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ backgroundColor: '#0F4C75' }}
          >
            {saving ? 'Setting password…' : 'Set password & continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
