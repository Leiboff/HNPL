'use client';

import { useCallback, useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { ABSOLUTE_SESSION_MAX_MS } from '@/lib/auth/sessionCap';
import { usePendingAction } from '@/components/loading/usePendingAction';
import { resendConfirmation } from '@/app/auth/resend/actions';
import { passkeyErrorMessage } from '@/lib/hooks/passkeyErrors';
import { usePasskeySignIn } from '@/lib/hooks/usePasskeySignIn';
import { recordLoginLanding } from '@/app/patient/passkey-actions';
import InstallCallout from '@/app/_pwa/InstallCallout';
import ContinueWithGoogleButton from '@/app/_components/ContinueWithGoogleButton';
import LastUsedPill from '@/app/_components/LastUsedPill';
import AuthSurface from '@/app/_components/AuthSurface';
import { getLastSignInMethod, setLastSignInMethod, type LastSignInMethod } from '@/lib/auth/lastSignInMethod';

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
  // Mirrors `loading` for PRESENTATION only — the flag itself and the
  // signInWithPassword call below are untouched. pending.disabled tracks
  // `loading` with no delay (double-tap safety), while pending.showLabel
  // waits out the flash threshold so a fast sign-in never blinks
  // "Signing in…". See components/loading/usePendingAction.ts.
  const pending = usePendingAction({ pending: loading });
  const [notice,   setNotice]   = useState<string | null>(null);

  const [notConfirmed, setNotConfirmed] = useState(false);
  const [resendState,  setResendState]  = useState<'idle' | 'sending' | 'sent'>('idle');

  // Post-login destination. Read once on mount from ?next= and clamp
  // to the same origin-relative allow-list used by /auth/callback.
  // Defaults to /dashboard (the role dispatcher).
  const [nextPath, setNextPath] = useState<string>('/dashboard');

  // Which method (if any) succeeded here last time — read once on mount,
  // purely a UI hint. See lib/auth/lastSignInMethod.ts.
  const [lastUsed, setLastUsed] = useState<LastSignInMethod | null>(null);

  // Conditional UI + modal passkey sign-in. The hook starts a hanging
  // navigator.credentials.get() with mediation:'conditional' on mount; the
  // input below carries autocomplete="username webauthn" so the browser
  // surfaces the saved passkey as an autofill suggestion. Tapping the
  // suggestion → Face ID / fingerprint → signed in, no button required.
  const onPasskeySuccess = useCallback(() => {
    setLastSignInMethod('passkey');
    window.location.href = nextPath;
  }, [nextPath]);
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
    // Absolute session cap (proxy.ts). A DIFFERENT message from
    // inactivity on purpose — the user was not idle, and telling them
    // they were is both wrong and confusing when they were mid-task.
    // Naming the cause makes it read as routine rather than as a fault.
    if (reason === 'session_expired') {
      // Derived from the constant the proxy enforces, not written out, so
      // the copy cannot drift away from the actual cap.
      const capHours = Math.round(ABSOLUTE_SESSION_MAX_MS / (60 * 60 * 1000));
      setNotice(`For your security, sessions end after ${capHours} hours. Please sign in again.`);
    }
  }, []);

  // ── Already signed in? Skip the form ──────────────────────────────────
  //
  // Neither this page nor proxy.ts checked for an existing session before
  // now, so a signed-in patient landing here — an old bookmark, the
  // marketing header's "Sign in" link, which is itself session-unaware by
  // design (see app/_landing/SiteHeader.tsx) — saw the login form again
  // instead of being sent straight to their dashboard.
  //
  // getSession() reads the cookie the browser client already has, no
  // network round trip: good enough to decide whether to bother showing a
  // form, not the security boundary. A session that has actually gone
  // stale gets bounced straight back here by nextPath's own server-side
  // guard (requireConfirmedUser / getRequestUser), so this shortcut can
  // only save a redundant form, never widen access.
  //
  // Reads ?next= itself rather than waiting on the nextPath state set
  // above — that effect and this one both fire on mount and ordering
  // between them is not guaranteed.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const next = safeNextParam(params.get('next'));
    createClient().auth.getSession().then(({ data: { session } }) => {
      if (!cancelled && session) window.location.href = next;
    });
    return () => { cancelled = true; };
  }, []);

  // Which method to highlight, and — for password — the address to
  // prefill. Read once; nothing here can change while the page is open.
  useEffect(() => {
    const { method, email: savedEmail } = getLastSignInMethod();
    if (!method) return;
    setLastUsed(method);
    if (method === 'password' && savedEmail) setEmail(savedEmail);
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

    setLastSignInMethod('password', email);
    window.location.href = nextPath;
  }

  async function handleResend() {
    setResendState('sending');
    try { await resendConfirmation(email); } catch { /* transport error — show neutral message */ }
    setResendState('sent');
    setTimeout(() => setResendState('idle'), 30_000);
  }

  return (
    <AuthSurface>

      {/* Brand mark */}
      <div className="text-center">
        <Link href="/" className="inline-block text-[46px] font-bold leading-none tracking-[-0.04em]">
          <span style={{ color: '#FFFFFF' }}>better</span><span style={{ color: '#4FD8CD' }}>now</span>
        </Link>
      </div>

      <h1 className="mt-9 text-center text-[31px] font-semibold leading-[1.2] tracking-[-0.03em] text-white">
        Welcome back
      </h1>
      <p className="mt-3 text-center text-[15px] text-[#9FB3CC]">
        Sign in to your betternow account.
      </p>

      {notice && (
        <div className="mt-7 rounded-2xl border border-[#4FD8CD]/25 bg-[#4FD8CD]/10 px-4 py-3 text-center text-[13px] leading-[1.55] text-[#BFE9E4]">
          {notice}
        </div>
      )}

      {error && (
        <div className="mt-7 rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-center text-[13px] leading-[1.55] text-red-200" role="alert">
          {error}
        </div>
      )}

      {notConfirmed && (
        <div className="mt-7 space-y-3 rounded-2xl border border-amber-300/30 bg-amber-400/[.10] px-4 py-4 text-[13px] leading-[1.55] text-amber-100">
          <p>Please confirm your email before signing in — check your inbox for the link.</p>
          {resendState === 'sent' && (
            <p className="font-medium text-[#8FE3D9]">
              If that email needs confirming, we&apos;ve sent a new link. Please check your inbox.
            </p>
          )}
          <button
            type="button"
            onClick={handleResend}
            disabled={resendState === 'sending' || resendState === 'sent'}
            className="flex h-[46px] w-full items-center justify-center rounded-full text-[14px] font-semibold text-[#06202B] transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: '#15A89E' }}
          >
            {resendState === 'sending' ? 'Sending…' : resendState === 'sent' ? 'Sent ✓' : 'Resend confirmation email'}
          </button>
        </div>
      )}

      {/* ── The ways back in ──────────────────────────────────────────
          Passkey first where the browser supports it: it is the fastest
          of the three and the only one that needs no typing. Unlike the
          /signup entry screen, a passkey button belongs HERE — everyone
          on this page already has an account, which is the precondition
          a passkey has and a signup screen cannot meet. */}
      <div className="mt-9 space-y-3">
        {passkeySupport && (
          <div>
            {lastUsed === 'passkey' && <LastUsedPill tone="onDark" />}
            <button
              type="button"
              onClick={handlePasskeySignIn}
              disabled={passkeyLoading || pending.disabled}
              className="flex h-[52px] w-full items-center justify-center gap-2.5 rounded-full border-[1.5px] text-[15px] font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              style={lastUsed === 'passkey' ? { borderColor: '#15A89E', boxShadow: '0 0 0 3px rgba(21,168,158,.12)', background: 'rgba(21,168,158,.12)' } : { borderColor: 'rgba(255,255,255,.24)', background: 'rgba(255,255,255,.05)' }}
            >
              <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              {passkeyLoading ? 'Authenticating…' : 'Sign in with a passkey'}
            </button>
          </div>
        )}

        {/* Sign in with Google — patient-context option. Staff accounts
            (practice / brand / admin) are provisioned via invitation
            emails and sign in with email + password; the "For patients"
            caption below the button makes the intent clear. A staff
            email whose Google identity is linked in Supabase Auth will
            still land correctly on their own role via the dispatcher —
            see /auth/callback for the profile belt-and-braces +
            role-preservation logic. */}
        <div data-testid="login-google-block">
          {/* Caption ABOVE the button, not below it. The button renders
              its own consent note underneath, and with the caption there
              too the two greys ran together into one block that labelled
              neither. Above, it reads as what it is: a heading for the
              option that follows. */}
          <p className="mb-2 text-center text-[11px] text-[#7A90AD]">
            For patients
          </p>
          <ContinueWithGoogleButton
            label="Sign in with Google"
            next={nextPath}
            onSignInAttempt={() => setLastSignInMethod('google')}
            highlighted={lastUsed === 'google'}
            tone="onDark"
          />
        </div>
      </div>

      <div className="relative mt-7 flex items-center">
        <div className="grow border-t border-white/[.12]" />
        <span className="mx-3 text-[12px] text-[#7A90AD]">or with password</span>
        <div className="grow border-t border-white/[.12]" />
      </div>

      {/* The password block gets the same teal-ring + pill treatment as
          the passkey/Google options above when IT was the last method
          to succeed — the one case that isn't a single button, so the
          highlight wraps the cue + form together rather than sitting on
          a single element. */}
      <div
        className="mt-6 rounded-2xl"
        style={lastUsed === 'password'
          ? { border: '1.5px solid #15A89E', background: 'rgba(21,168,158,.08)', padding: '16px' }
          : undefined}
      >
        {lastUsed === 'password' && <LastUsedPill tone="onDark" />}

        {/* The "For patients" caption above belongs to the GOOGLE button
            (staff accounts are invite-provisioned and use email +
            password). Sitting directly above this divider, though, it read
            as labelling everything below it — leaving practice staff unsure
            this password form was for them at all. This one line says the
            form is shared; it deliberately does not touch the Google or
            passkey options. */}
        <p
          data-testid="password-audience-cue"
          className="mb-5 text-center text-[12px] leading-[1.55] text-[#8AA0BC]"
        >
          For <span className="font-medium text-white">patients and practices</span> — sign in
          with the email you registered.
        </p>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-[7px] block text-[13px] font-medium text-[#9FB3CC]">
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
              // on focus. It is why this input must stay rendered on mount
              // rather than hiding behind a "sign in with email" reveal.
              autoComplete="username webauthn"
              className="h-[52px] w-full rounded-2xl border-[1.5px] border-white/20 bg-white/[.06] px-4 text-[15px] text-white outline-none transition-all placeholder:text-white/35 focus:border-[#4FD8CD] focus:bg-white/[.10] focus:ring-4 focus:ring-[#4FD8CD]/15"
              placeholder="jane@example.com"
            />
          </div>

          <div>
            <div className="mb-[7px] flex items-center justify-between">
              <label htmlFor="password" className="block text-[13px] font-medium text-[#9FB3CC]">
                Password
              </label>
              <Link
                href="/forgot-password"
                data-testid="login-forgot-password"
                className="text-[12px] font-semibold underline underline-offset-[3px] text-[#9FB3CC] hover:text-white"
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
              className="h-[52px] w-full rounded-2xl border-[1.5px] border-white/20 bg-white/[.06] px-4 text-[15px] text-white outline-none transition-all placeholder:text-white/35 focus:border-[#4FD8CD] focus:bg-white/[.10] focus:ring-4 focus:ring-[#4FD8CD]/15"
              placeholder="Your password"
            />
          </div>

          <button
            type="submit"
            disabled={pending.disabled}
            className="flex h-[54px] w-full items-center justify-center rounded-full text-[16px] font-semibold text-[#06202B] transition-transform active:scale-[.985] disabled:cursor-not-allowed disabled:opacity-45"
            style={{ background: '#15A89E', boxShadow: pending.disabled ? 'none' : '0 14px 30px -12px rgba(21,168,158,.75)' }}
          >
            {pending.showLabel ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>

      {/* ── Signup CTAs ───────────────────────────────────────────────
          Both roles, named explicitly. A login page is the one place a
          visitor already knows which of the two they are, so these stay
          direct links rather than routing through the /signup chooser. */}
      <section
        aria-label="New to BetterNow"
        className="mt-9 rounded-2xl border border-white/[.12] bg-white/[.04] p-5"
      >
        <p className="mb-3.5 text-center text-[13px] font-semibold text-white">
          New to BetterNow?
        </p>
        <div className="space-y-2.5">
          <Link
            href="/signup/patient"
            data-testid="login-signup-patient"
            className="block rounded-xl border border-white/[.14] bg-white/[.05] px-4 py-3 transition-colors hover:border-[#4FD8CD]/50 hover:bg-white/[.09]"
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#7A90AD]">
              Patient
            </p>
            <p className="mt-0.5 text-[15px] font-semibold text-white">
              Sign up as a patient
            </p>
            <p className="mt-0.5 text-[12px] text-[#8AA0BC]">
              Pay medical bills in interest-free instalments.
            </p>
          </Link>
          <Link
            href="/signup/practice"
            data-testid="login-signup-practice"
            className="block rounded-xl border border-white/[.14] bg-white/[.05] px-4 py-3 transition-colors hover:border-[#4FD8CD]/50 hover:bg-white/[.09]"
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#7A90AD]">
              Practice
            </p>
            <p className="mt-0.5 text-[15px] font-semibold text-white">
              Register your practice
            </p>
            <p className="mt-0.5 text-[12px] text-[#8AA0BC]">
              Offer BetterNow to your patients.
            </p>
          </Link>
        </div>
      </section>

      {/* PWA install callout — placed, persistent, secondary visual
          weight so it doesn't compete with Sign in. Hidden when the
          page is already running in the installed app (display-mode
          standalone) or when the runtime can't install at all. Its own
          white card reads as a deliberate object on the navy, so it
          needs no dark variant. */}
      <div className="mt-6">
        <InstallCallout />
      </div>
    </AuthSurface>
  );
}
