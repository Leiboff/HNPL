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
import AuthConsentNote from '@/app/_components/AuthConsentNote';
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

  // ── Two views, one route ──────────────────────────────────────────────
  //
  // false → the method chooser (passkey / Google / email).
  // true  → the email sign-in screen, which REPLACES the chooser rather
  //         than expanding below it. Same component, same URL, but the
  //         chooser, the signup CTAs and the install callout all leave,
  //         so it arrives as a screen you moved to, not a panel that
  //         unfolded. app/globals.css carries the slide that sells it.
  //
  // Because it looks like a page, it has to behave like one: openEmail
  // pushes a history entry and closeEmail pops it, so the device/browser
  // back button returns to the chooser instead of leaving /login
  // altogether. Both the on-screen back arrow and the hardware button
  // therefore run the same path — history.back() → popstate → close.
  //
  // This flag also tells usePasskeySignIn when to start the conditional-UI
  // ceremony: that ceremony binds to the autocomplete="username webauthn"
  // input, which does not exist until this is true. Starting it on mount
  // would bind to nothing and the passkey suggestion would silently never
  // appear.
  const [emailOpen, setEmailOpen] = useState(false);
  // Which direction the current view arrived from, for the slide.
  const [viewDir, setViewDir] = useState<'forward' | 'back'>('forward');

  function openEmail() {
    setViewDir('forward');
    setEmailOpen(true);
    try { window.history.pushState({ hnplLoginView: 'email' }, ''); } catch { /* non-fatal: the arrow still works */ }
  }

  function closeEmail() {
    // Go through history so this and the hardware back button share one
    // path; popstate below does the actual state change.
    if (window.history.state?.hnplLoginView === 'email') { window.history.back(); return; }
    setViewDir('back');
    setEmailOpen(false);
  }

  useEffect(() => {
    function onPop() {
      setViewDir('back');
      setEmailOpen(false);
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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
    usePasskeySignIn({ onSuccess: onPasskeySuccess, conditionalWhen: emailOpen });

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
    // Deliberately NOT auto-opening the email screen for them. When the
    // form merely expanded, opening it early was a free convenience; now
    // that it is a screen, landing on it directly means never seeing the
    // one you supposedly came from. The highlighted "Sign in with email"
    // button on the chooser carries them instead, one tap away.
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

      {/* Brand mark — the one piece of chrome both views share, so the
          screen change reads as movement inside one app rather than a
          jump somewhere else. */}
      <div className="text-center">
        <Link href="/" className="inline-block text-[46px] font-bold leading-none tracking-[-0.04em]">
          <span style={{ color: '#FFFFFF' }}>better</span><span style={{ color: 'var(--auth-accent)' }}>now</span>
        </Link>
      </div>

      {/* Banners live above the view switch: a passkey error is raised on
          the chooser, a password error on the email screen, and the
          not-confirmed state can come from either. */}
      {notice && (
        <div className="mt-7 rounded-2xl border border-[var(--auth-accent-edge)] bg-[var(--auth-accent-tint)] px-4 py-3 text-center text-[13px] leading-[1.55] text-[var(--auth-muted)]">
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
            <p className="font-medium text-[var(--auth-accent)]">
              If that email needs confirming, we&apos;ve sent a new link. Please check your inbox.
            </p>
          )}
          <button
            type="button"
            onClick={handleResend}
            disabled={resendState === 'sending' || resendState === 'sent'}
            className="flex h-[46px] w-full items-center justify-center rounded-full text-[14px] font-semibold text-[var(--auth-on-teal)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: 'var(--auth-teal)' }}
          >
            {resendState === 'sending' ? 'Sending…' : resendState === 'sent' ? 'Sent ✓' : 'Resend confirmation email'}
          </button>
        </div>
      )}

      {!emailOpen ? (
        /* ─── View 1: how do you want to sign in? ───────────────────── */
        <div key="chooser" className={`auth-view-${viewDir}`} data-testid="login-view-chooser">
          <h1 className="mt-9 text-center text-[31px] font-semibold leading-[1.2] tracking-[-0.03em] text-white">
            Welcome back
          </h1>
          <p className="mt-3 text-center text-[15px] text-[var(--auth-muted)]">
            Sign in to your betternow account.
          </p>

          {/* Passkey first where the browser supports it: it is the
              fastest of the three and the only one that needs no typing.
              Unlike the /signup entry screen, a passkey button belongs
              HERE — everyone on this page already has an account, which
              is the precondition a passkey has and a signup screen
              cannot meet. */}
          <div className="mt-9 space-y-3">
            {passkeySupport && (
              <div>
                {lastUsed === 'passkey' && <LastUsedPill tone="onDark" />}
                <button
                  type="button"
                  onClick={handlePasskeySignIn}
                  disabled={passkeyLoading || pending.disabled}
                  className="flex h-[52px] w-full items-center justify-center rounded-full border-[1.5px] text-[15px] font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  style={lastUsed === 'passkey' ? { borderColor: '#15A89E', boxShadow: '0 0 0 3px rgba(21,168,158,.12)', background: 'rgba(21,168,158,.12)' } : { borderColor: 'var(--auth-edge-strong)', background: 'var(--auth-fill)' }}
                >
                  <span className="auth-option-row">
                    <svg className="h-[18px] w-[18px] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    <span className="auth-option-label">
                      {passkeyLoading ? 'Authenticating…' : 'Sign in with a passkey'}
                    </span>
                  </span>
                </button>
              </div>
            )}

            {/* Sign in with Google. In practice this is a patient path —
                staff accounts (practice / brand / admin) are provisioned
                by invitation and sign in with email + password — but that
                is no longer spelled out in a caption under the button. A
                staff email whose Google identity IS linked in Supabase
                Auth still lands correctly on its own role via the
                dispatcher; see /auth/callback for the profile
                belt-and-braces + role-preservation logic. */}
            <div data-testid="login-google-block">
              <ContinueWithGoogleButton
                label="Sign in with Google"
                next={nextPath}
                onSignInAttempt={() => setLastSignInMethod('google')}
                highlighted={lastUsed === 'google'}
                tone="onDark"
                shape="pill"
                // Suppressed in favour of the stack-wide line below: the
                // disclosure covers passkey and email too, and saying it
                // twice on one screen reads as two different promises.
                showConsentNote={false}
              />
            </div>

            {/* The third option. It navigates rather than expands — see
                the openEmail/closeEmail pair above. Carries the same
                teal-ring + pill treatment as the other two when it was
                the last method to succeed, which is what replaces the
                old auto-open. */}
            <div>
              {lastUsed === 'password' && <LastUsedPill tone="onDark" />}
              <button
                type="button"
                onClick={openEmail}
                data-testid="login-open-email"
                className="flex h-[52px] w-full items-center justify-center rounded-full border-[1.5px] text-[15px] font-medium text-white transition-colors hover:bg-[var(--auth-fill-hover)]"
                style={lastUsed === 'password' ? { border: '1.5px solid #15A89E', boxShadow: '0 0 0 3px rgba(21,168,158,.12)', background: 'rgba(21,168,158,.12)' } : { borderColor: 'var(--auth-edge-strong)', background: 'var(--auth-fill)' }}
              >
                <span className="auth-option-row">
                  <svg className="h-[18px] w-[18px] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <path d="m3 7 9 6 9-6" />
                  </svg>
                  <span className="auth-option-label">Sign in with email</span>
                </span>
              </button>
            </div>
          </div>

          {/* One legal line beneath ALL THREE options. Every one of them
              can be the moment an account first exists — Google provisions
              on first sign-in — so the disclosure belongs to the stack,
              not to any single button. /auth/callback records the
              acceptance this line makes. */}
          <AuthConsentNote className="mt-5" action="signing in" />

          {/* ── A different kind of action ───────────────────────────
              Not a fourth pill. The three options above are one task —
              sign in — and giving signup the same height, shape and fill
              made it read as another way to do that task rather than a
              different journey for a different person.
              
              So it is differentiated the way hierarchy normally is:
              typography instead of a control, the accent colour instead
              of a border, and a hairline to mark that the screen has
              moved on from its primary job. It also now mirrors the
              footer on /signup ("Already have an account? Sign in"), so
              the pair reads as one system from either direction.

              It is NOT the grey footer link this replaced years ago —
              see app/password-reset-flow.test.ts, which still guards
              against that. It sits directly under the options, above the
              fold, in the brand accent. Subordinate, not buried. */}
          <div className="mt-8 border-t border-[var(--auth-hairline)] pt-7">
            <p className="text-center text-[15px] text-[var(--auth-muted)]">
              New to betternow?{' '}
              <Link
                href="/signup"
                data-testid="login-signup-patient"
                className="font-semibold underline-offset-[3px] hover:underline"
                style={{ color: 'var(--auth-accent)' }}
              >
                Sign up
              </Link>
            </p>
          </div>

          {/* PWA install callout — secondary visual weight so it doesn't
              compete with the sign-in options. Hidden when the page is
              already running in the installed app (display-mode
              standalone) or when the runtime can't install at all. Its
              own white card reads as a deliberate object on the navy, so
              it needs no dark variant. Chooser-only: an install nudge on
              a screen where someone is mid-way through typing a password
              is an interruption, not an offer. */}
          <div className="mt-6">
            <InstallCallout />
          </div>
        </div>
      ) : (
        /* ─── View 2: sign in with email ────────────────────────────── */
        <div key="email" className={`auth-view-${viewDir}`} data-testid="login-view-email">
          <button
            type="button"
            onClick={closeEmail}
            data-testid="login-email-back"
            className="mt-8 -ml-2 flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[14px] font-medium text-[var(--auth-muted)] transition-colors hover:text-white"
          >
            <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 18-6-6 6-6" />
            </svg>
            Back
          </button>

          <h1 className="mt-4 text-[28px] font-semibold leading-[1.2] tracking-[-0.03em] text-white">
            Sign in with email
          </h1>
          {/* Sits directly above the fields and claims no audience — see
              app/practice/practice-dashboard-ux.test.ts for why the
              wording must never re-narrow to one of them. */}
          <p
            data-testid="password-audience-cue"
            className="mt-2 mb-7 text-[15px] text-[var(--auth-muted)]"
          >
            Use the address you registered with.
          </p>

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-[7px] block text-[13px] font-medium text-[var(--auth-muted)]">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                autoFocus
                value={email}
                onChange={e => setEmail(e.target.value)}
                // "username webauthn" tells the browser this field can be
                // filled by a passkey suggestion (Conditional UI). The
                // hook starts that ceremony when emailOpen flips true —
                // i.e. when THIS input reaches the DOM.
                autoComplete="username webauthn"
                className="h-[52px] w-full rounded-2xl border-[1.5px] border-[var(--auth-edge)] bg-[var(--auth-fill-raised)] px-4 text-[15px] text-white outline-none transition-all placeholder:text-white/35 focus:border-[var(--auth-accent)] focus:bg-[var(--auth-fill-hover)] focus:ring-4 focus:ring-[var(--auth-accent-ring)]"
                placeholder="jane@example.com"
              />
            </div>

            <div>
              <div className="mb-[7px] flex items-center justify-between">
                <label htmlFor="password" className="block text-[13px] font-medium text-[var(--auth-muted)]">
                  Password
                </label>
                <Link
                  href="/forgot-password"
                  data-testid="login-forgot-password"
                  className="text-[12px] font-semibold text-[var(--auth-muted)] underline underline-offset-[3px] hover:text-white"
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
                className="h-[52px] w-full rounded-2xl border-[1.5px] border-[var(--auth-edge)] bg-[var(--auth-fill-raised)] px-4 text-[15px] text-white outline-none transition-all placeholder:text-white/35 focus:border-[var(--auth-accent)] focus:bg-[var(--auth-fill-hover)] focus:ring-4 focus:ring-[var(--auth-accent-ring)]"
                placeholder="Your password"
              />
            </div>

            <button
              type="submit"
              disabled={pending.disabled}
              className="flex h-[54px] w-full items-center justify-center rounded-full text-[16px] font-semibold text-[var(--auth-on-teal)] transition-transform active:scale-[.985] disabled:cursor-not-allowed disabled:opacity-45"
              style={{ background: 'var(--auth-teal)', boxShadow: pending.disabled ? 'none' : '0 14px 30px -12px rgba(21,168,158,.75)' }}
            >
              {pending.showLabel ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      )}

    </AuthSurface>
  );
}
