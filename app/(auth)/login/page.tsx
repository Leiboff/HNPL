'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { resendConfirmation } from '@/app/auth/resend/actions';

export default function LoginPage() {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [notice,   setNotice]   = useState<string | null>(null);

  const [notConfirmed, setNotConfirmed] = useState(false);
  const [resendState,  setResendState]  = useState<'idle' | 'sending' | 'sent'>('idle');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const msg = params.get('message');
    if (msg) setNotice(decodeURIComponent(msg));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotConfirmed(false);
    setResendState('idle');
    setLoading(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      if (signInError.message.includes('not confirmed')) setNotConfirmed(true);
      else setError(signInError.message);
      setLoading(false);
      return;
    }

    window.location.href = '/dashboard';
  }

  async function handleResend() {
    setResendState('sending');
    try { await resendConfirmation(email); } catch { /* transport error — show neutral message */ }
    setResendState('sent');
    setTimeout(() => setResendState('idle'), 30_000);
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{
        background: '#f7fbfb',
        backgroundImage: 'radial-gradient(58% 48% at 84% 0%, rgba(21,168,158,.12), transparent 70%), radial-gradient(48% 42% at 4% 90%, rgba(19,41,75,.07), transparent 70%)',
      }}
    >
      <div className="w-full max-w-md">

        {/* Brand mark */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-block text-2xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
            <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
          </Link>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200/80 p-8">
          <div className="mb-7">
            <h1 className="text-2xl font-semibold" style={{ color: '#13294B', fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
              Welcome back
            </h1>
            <p className="mt-1 text-sm text-gray-500">Sign in to your BetterNow account.</p>
          </div>

          {notice && (
            <div className="mb-6 rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-700">
              {notice}
            </div>
          )}

          {error && (
            <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {notConfirmed && (
            <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-800 space-y-3">
              <p>Please confirm your email before signing in — check your inbox for the link.</p>
              {resendState === 'sent' && (
                <p className="font-medium text-green-700">
                  If that email needs confirming, we&apos;ve sent a new link. Please check your inbox.
                </p>
              )}
              <button
                type="button"
                onClick={handleResend}
                disabled={resendState === 'sending' || resendState === 'sent'}
                className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed transition-all"
                style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
              >
                {resendState === 'sending' ? 'Sending…' : resendState === 'sent' ? 'Sent ✓' : 'Resend confirmation email'}
              </button>
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none transition-all focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20"
                placeholder="jane@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none transition-all focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20"
                placeholder="Your password"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500">
            Don&apos;t have an account?{' '}
            <Link href="/" className="font-semibold hover:underline" style={{ color: '#13294B' }}>
              Sign up
            </Link>
          </p>
        </div>

        <div className="mt-6 flex justify-center gap-6 text-xs text-gray-400">
          <Link href="/signup/practice" className="hover:text-gray-600 transition-colors">Practice sign-up</Link>
          <span>·</span>
          <Link href="/signup/patient" className="hover:text-gray-600 transition-colors">Patient sign-up</Link>
        </div>
      </div>
    </div>
  );
}
