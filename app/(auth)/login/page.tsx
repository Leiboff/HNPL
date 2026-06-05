'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { resendConfirmation } from '@/app/auth/resend/actions';

export default function LoginPage() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);
  const [notice, setNotice]     = useState<string | null>(null);

  // Unconfirmed-email recovery state
  const [notConfirmed, setNotConfirmed] = useState(false);
  const [resendState, setResendState]   = useState<'idle' | 'sending' | 'sent'>('idle');

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

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      if (signInError.message.includes('not confirmed')) {
        setNotConfirmed(true);
      } else {
        setError(signInError.message);
      }
      setLoading(false);
      return;
    }

    // Hard redirect so the browser sends a fresh HTTP request with the new
    // session cookies. Using router.replace() + router.refresh() in Next.js 16
    // creates conflicting navigation operations that can stall rendering.
    window.location.href = '/dashboard';
  }

  async function handleResend() {
    setResendState('sending');
    try {
      await resendConfirmation(email);
    } catch {
      // Server action failed at transport level — still show neutral message.
    }
    setResendState('sent');
    setTimeout(() => setResendState('idle'), 30_000);
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-gray-900">
            Welcome back
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Sign in to your BetterNow account.
          </p>
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
          <div className="mb-6 rounded-lg bg-amber-50 border border-amber-200 px-4 py-4 text-sm text-amber-800 space-y-3">
            <p>
              Please confirm your email before signing in — check your inbox for the link.
            </p>
            {resendState === 'sent' && (
              <p className="font-medium text-green-700">
                If that email needs confirming, we&apos;ve sent a new link. Please check your inbox.
              </p>
            )}
            <button
              type="button"
              onClick={handleResend}
              disabled={resendState === 'sending' || resendState === 'sent'}
              className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ backgroundColor: '#0F4C75' }}
            >
              {resendState === 'sending'
                ? 'Sending…'
                : resendState === 'sent'
                  ? 'Sent ✓'
                  : 'Resend confirmation email'}
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Email address
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="jane@example.com"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700"
              >
                Password
              </label>
            </div>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Your password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-500">
          Don&apos;t have an account?{' '}
          <Link
            href="/"
            className="font-medium text-blue-600 hover:text-blue-700"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
