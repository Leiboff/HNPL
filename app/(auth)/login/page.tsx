'use client';

import { useCallback, useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { resendConfirmation } from '@/app/auth/resend/actions';
import { passkeyErrorMessage } from '@/lib/hooks/passkeyErrors';
import { usePasskeySignIn } from '@/lib/hooks/usePasskeySignIn';
import { recordLoginLanding } from '@/app/patient/passkey-actions';
import InstallCallout from '@/app/_pwa/InstallCallout';
import ContinueWithGoogleButton from '@/app/_components/ContinueWithGoogleButton';

// Validate ?next= from the URL — must be origin-relative and not
// protocol-relative. Mirrors the /auth/callback safeNext posture so
// the two enforcement paths cannot disagree. Anything else → default.
function safeNextParam(raw: string | null | undefined): string {
  const DEFAULT = '/dashboard';
  if (!raw) return DEFAULT;
  if (!raw.startsWith('/') || raw.startsWith('//')) return DEFAULT;
  return raw;
}

export default function LoginPage() {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [notice,   setNotice]   = useState<string | null>(null);

  const [notConfirmed, setNotConfirmed] = useState(false);
  const [resendState,  setResendState]  = useState<'idle' | 'sending' | 'sent'>('idle');

  // Post-login destination. Read once on mount from ?next= and clamp
  // to the same origin-relative allow-list used by /auth/callback.
  // Defaults to /dashboard (the role dispatcher).
  const [nextPath, setNextPath] = useState<string>('/dashboard');

  // Conditional UI + modal passkey sign-in. The hook starts a hanging
  // navigator.credentials.get() with mediation:'conditional' on mount; the
  // input below carries autocomplete="username webauthn" so the browser
  // surfaces the saved passkey as an autofill suggestion. Tapping the
  // suggestion → Face ID / fingerprint → signed in, no button required.
  const onPasskeySuccess = useCallback(() => { window.location.href = nextPath; }, [nextPath]);
  const { supported: passkeySupport, signIn: signInWithPasskey, loading: passkeyLoading, error: passkeyError } =
    usePasskeySignIn({ onSuccess: onPasskeySuccess });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNextPath(safeNextParam(params.get('next')));
    const msg = params.get('message');
    if (msg) setNotice(decodeURIComponent(msg));
    // Inactivity auto-logout landing — informational, not an error.
    // Set once here; the general `?message=` handler wouldn't add any
    // useful specificity for this particular reason code.
    const reason = params.get('reason');
    if (reason === 'inactivity') {
      setNotice('You were signed out due to inactivity.');
    }
  }, []);

  // Surface passkey hook errors in the existing error region. user_cancelled
  // is filtered out by the hook before it sets state, so anything we see
  // here is worth showing.
  useEffect(() => {
    if (!passkeyError) return;
    if (passkeyError === 'email_not_confirmed') { setNotConfirmed(true); return; }
    setError(passkeyErrorMessage(passkeyError));
  }, [passkeyError]);

  async function handlePasskeySignIn() {
    setError(null);
    setNotConfirmed(false);
    await signInWithPasskey();
  }

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

    // 0065: increment profile.login_count before navigating. The
    // patient layout reads this to decide whether to render the
    // post-login passkey prompt. Best-effort — a failed increment
    // just skips one login and the next covers it.
    try {
      await recordLoginLanding();
    } catch {
      // Swallow — prompt frequency capping is a nudge, not a gate.
    }

    window.location.href = nextPath;
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

          {passkeySupport && (
            <div className="mb-3">
              <button
                type="button"
                onClick={handlePasskeySignIn}
                disabled={passkeyLoading || loading}
                className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                {passkeyLoading ? 'Authenticating…' : 'Sign in with a passkey'}
              </button>
            </div>
          )}

          {/* Continue with Google — patient-context option. Staff
              accounts (practice / brand / admin) are provisioned via
              invitation emails and sign in with email + password; the
              "For patients" caption below the button makes the intent
              clear. A staff email whose Google identity is linked in
              Supabase Auth will still land correctly on their own role
              via the dispatcher — see /auth/callback for the profile
              belt-and-braces + role-preservation logic. */}
          <div className="mb-5 space-y-2" data-testid="login-google-block">
            <ContinueWithGoogleButton label="Sign in with Google" next={nextPath} />
            <p className="text-center text-[11px] text-gray-400">
              For patients
            </p>
            <div className="relative flex items-center pt-2">
              <div className="grow border-t border-gray-200" />
              <span className="mx-3 text-xs text-gray-400">or with password</span>
              <div className="grow border-t border-gray-200" />
            </div>
          </div>

          {/* The "For patients" caption above belongs to the GOOGLE button
              (staff accounts are invite-provisioned and use email +
              password). Sitting directly above this divider, though, it read
              as labelling everything below it — leaving practice staff unsure
              this password form was for them at all. This one line says the
              form is shared; it deliberately does not touch the Google or
              passkey options. */}
          <p
            data-testid="password-audience-cue"
            className="mb-4 text-center text-xs text-gray-500"
          >
            For <span className="font-medium text-gray-700">patients and practices</span> — sign in
            with the email you registered.
          </p>

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
                // "username webauthn" tells the browser this field can be
                // filled by a passkey suggestion (Conditional UI). The hook
                // mounts the conditional ceremony so the suggestion appears
                // on focus.
                autoComplete="username webauthn"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none transition-all focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20"
                placeholder="jane@example.com"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                  Password
                </label>
                <Link
                  href="/forgot-password"
                  data-testid="login-forgot-password"
                  className="text-xs font-semibold underline underline-offset-2"
                  style={{ color: '#13294B' }}
                >
                  Forgot password?
                </Link>
              </div>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password webauthn"
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
        </div>

        {/* ── Prominent signup CTAs ────────────────────────────────────
            Previously buried as small grey footer links + a "Sign up"
            text link pointing at the homepage. New visitors need a
            clear one-glance path in — this section makes both patient
            and practice signup visible as bordered cards with distinct
            purpose. Mobile-first: cards stack vertically. */}
        <section
          aria-label="New to BetterNow"
          className="mt-6 bg-white rounded-2xl shadow-sm border border-gray-200/80 p-6"
        >
          <p className="text-sm font-semibold text-center mb-4" style={{ color: '#13294B' }}>
            New to BetterNow?
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Link
              href="/signup/patient"
              data-testid="login-signup-patient"
              className="group rounded-xl border border-[rgba(19,41,75,.12)] bg-white px-4 py-3 hover:shadow-md transition-shadow"
            >
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">
                Patient
              </p>
              <p className="mt-1 font-semibold" style={{ color: '#13294B' }}>
                Sign up as a patient
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Pay medical bills in interest-free instalments.
              </p>
            </Link>
            <Link
              href="/signup/practice"
              data-testid="login-signup-practice"
              className="group rounded-xl border border-[rgba(19,41,75,.12)] bg-white px-4 py-3 hover:shadow-md transition-shadow"
            >
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">
                Practice
              </p>
              <p className="mt-1 font-semibold" style={{ color: '#13294B' }}>
                Register your practice
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Offer BetterNow to your patients.
              </p>
            </Link>
          </div>
        </section>

        {/* PWA install callout — placed, persistent, secondary visual
            weight so it doesn't compete with Sign in. Hidden when the
            page is already running in the installed app (display-mode
            standalone) or when the runtime can't install at all. */}
        <div className="mt-6">
          <InstallCallout />
        </div>
      </div>
    </div>
  );
}
