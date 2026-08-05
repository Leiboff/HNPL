'use client';

import { useEffect, useState, type ReactNode } from 'react';
import OtpInput, { OTP_LENGTH } from '@/components/OtpInput';

// ─── PhoneOtpStep ────────────────────────────────────────────────────────
//
// Single shared OTP-verification step used by:
//   • app/checkout/[token]/CheckoutForm.tsx  — Verify step (post-Details)
//   • app/(auth)/verify-phone/page.tsx       — organic-signup phone gate
//
// The two surfaces call into different server actions (the checkout's
// requestPhoneOtp / verifyPhoneOtp are keyed by invitation_token; the
// signup variants are keyed by user_id) but the UI + state machine is
// identical — auto-send on mount, 30s resend cooldown, auto-submit on
// 6th digit, change-number escape hatch, coded-error mapping.
//
// Built on the existing components/OtpInput (the 6-cell input already
// used by /verify-email). That keeps the OTP visual identical across
// the three places we ask for a code — same look, same autofill, same
// keyboard / paste behaviour.
//
// The caller passes the server actions as `requestCode` / `verifyCode`
// callbacks. We don't construct Supabase clients or hit /api here —
// this file is pure UI. Both callbacks return the same shape:
//   { ok: true } | { ok: false; code: string }
// where `code` is the stable coded-error string from the action.

const OTP_RESEND_COOLDOWN_MS = 30 * 1000;

export type PhoneOtpRequestResult =
  | { ok: true }
  | { ok: false; code: string };

export type PhoneOtpVerifyResult =
  | { ok: true }
  | { ok: false; code: string };

type Props = {
  /** Display-only — appears in the subhead so the patient can confirm what we're verifying. */
  phoneDisplay:   string;
  /** Fires the SMS send. Called once on mount + on each Resend click. */
  requestCode:    () => Promise<PhoneOtpRequestResult>;
  /** Fires the verify RPC. Called on the 6th digit. */
  verifyCode:     (code: string) => Promise<PhoneOtpVerifyResult>;
  /** Called after verifyCode returns { ok: true }. */
  onVerified:     () => void;
  /** Optional — when present, surfaces a "← Change number" link that calls this. */
  onChangeNumber?: () => void;
  /** Optional render-prop wrapper for the body. Used by CheckoutForm to embed
   *  inside its StepShell; signup page passes nothing and gets the default
   *  card chrome. */
  shell?:         (body: ReactNode, actions: ReactNode) => ReactNode;
};

// Coded errors from both keying paths share the same vocabulary. We
// type the argument as `string` so additional codes added later don't
// require a TS shuffle — unknown codes fall through to the default.
function otpErrorCopy(code: string): string {
  switch (code) {
    case 'too_soon':            return 'Please wait a moment before requesting another code.';
    case 'daily_limit':         return 'Too many code requests today. Try again tomorrow.';
    case 'token_daily_limit':   return 'Too many code requests for this bill today. Try again tomorrow or contact your practice.';
    case 'user_daily_limit':    return 'Too many code requests today. Try again tomorrow.';
    case 'phone_mismatch':      return 'That number doesn’t match the one on your account. Update your profile first.';
    case 'invalid_token':       return 'This invitation link is no longer valid.';
    case 'invalid_user':        return 'We couldn’t verify your account. Please sign in again.';
    case 'invalid_phone':       return 'That phone number looks wrong. Go back and check it.';
    case 'invalid_code_format': return 'Please enter the 6-digit code.';
    case 'wrong_code':          return 'That code didn’t match — try again.';
    case 'expired':             return 'That code expired. Tap Resend to get a fresh one.';
    case 'too_many_attempts':   return 'Too many wrong codes. Tap Resend to start over.';
    case 'not_found':           return 'We couldn’t find your verification — tap Resend.';
    case 'sms_failed':          return 'We couldn’t send the SMS just now. Tap Resend to retry.';
    case 'sms_not_configured':  return 'SMS isn’t set up in this environment.';
    default:                    return 'Something went wrong. Tap Resend to try again.';
  }
}

export default function PhoneOtpStep({
  phoneDisplay,
  requestCode,
  verifyCode,
  onVerified,
  onChangeNumber,
  shell,
}: Props) {
  const [code,           setCode]           = useState('');
  const [otpError,       setOtpError]       = useState<string | null>(null);
  const [sending,        setSending]        = useState(false);
  const [verifying,      setVerifying]      = useState(false);
  const [sentOnce,       setSentOnce]       = useState(false);
  const [resendUnlock,   setResendUnlock]   = useState<number>(0);  // epoch ms
  const [remaining,      setRemaining]      = useState<number>(0);  // seconds until resend unlocks
  // Fatal "SMS isn't configured" gets its own UI branch (no resend
  // makes sense in that state — there's nothing to retry against).
  const [smsUnavailable, setSmsUnavailable] = useState(false);

  // ── Auto-send on mount ─────────────────────────────────────────────
  // The patient just arrived at this step; they didn't ask for a send,
  // we know they need one. Same UX as the checkout step. setSentOnce
  // guards against React strict-mode double-invoke + StepShell parent
  // re-renders re-firing this effect.
  useEffect(() => {
    if (sentOnce) return;
    (async () => {
      setOtpError(null);
      setSending(true);
      try {
        const r = await requestCode();
        if (r.ok) {
          setSentOnce(true);
          setResendUnlock(Date.now() + OTP_RESEND_COOLDOWN_MS);
        } else {
          if (r.code === 'sms_not_configured') setSmsUnavailable(true);
          setOtpError(otpErrorCopy(r.code));
        }
      } catch {
        setOtpError(otpErrorCopy('unknown'));
      } finally {
        setSending(false);
      }
    })();
  // requestCode is a server-action ref the parent recreates on each
  // render — listing it in deps would re-fire the auto-send on every
  // parent render. The sentOnce guard inside the effect is the real
  // safeguard, not the deps array.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Resend countdown driven by interval (NOT computed in render) ──
  // react-hooks/purity rightly flags Date.now() in the render body —
  // a re-render triggered by unrelated state would see stale values.
  useEffect(() => {
    const compute = () => Math.max(0, Math.ceil((resendUnlock - Date.now()) / 1000));
    (async () => { setRemaining(compute()); })();
    if (compute() <= 0) return;
    const id = window.setInterval(() => {
      const next = compute();
      setRemaining(next);
      if (next <= 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [resendUnlock]);

  async function handleResend() {
    if (Date.now() < resendUnlock || sending) return;
    setOtpError(null);
    setSending(true);
    try {
      const r = await requestCode();
      if (r.ok) {
        setCode('');
        setResendUnlock(Date.now() + OTP_RESEND_COOLDOWN_MS);
      } else {
        if (r.code === 'sms_not_configured') setSmsUnavailable(true);
        setOtpError(otpErrorCopy(r.code));
      }
    } finally {
      setSending(false);
    }
  }

  async function handleVerify(submitted: string) {
    if (!/^\d{6}$/.test(submitted)) return;
    setOtpError(null);
    setVerifying(true);
    try {
      const r = await verifyCode(submitted);
      if (r.ok) {
        onVerified();
        return;
      }
      setOtpError(otpErrorCopy(r.code));
      // After lock or expiry the next action is Resend, not retype.
      if (r.code === 'too_many_attempts' || r.code === 'expired') {
        setCode('');
      }
    } finally {
      setVerifying(false);
    }
  }

  function handleChangeCode(next: string) {
    setCode(next);
    // Clear the inline error as soon as they start retyping.
    if (otpError) setOtpError(null);
  }

  const body = (
    <>
      <p className="text-[15px] leading-[1.6]" style={{ color: '#6B7C93' }}>
        We sent a 6-digit code to{' '}
        <span className="font-semibold tabular-nums" style={{ color: '#13294B' }}>{phoneDisplay || 'your number'}</span>.
      </p>

      <OtpInput
        value={code}
        onChange={handleChangeCode}
        onComplete={(full) => void handleVerify(full)}
        disabled={verifying || smsUnavailable}
        hasError={!!otpError}
        autoFocus
      />

      {otpError && (
        <p role="alert" className="text-center text-xs" style={{ color: '#D14141' }}>{otpError}</p>
      )}

      <div className="flex flex-col items-center gap-2 text-center">
        {!smsUnavailable && (
          sending ? (
            <span className="text-[14px]" style={{ color: '#7A8AA0' }}>Sending code…</span>
          ) : remaining > 0 ? (
            <span className="text-[14px]" style={{ color: '#7A8AA0' }}>
              Didn’t arrive? Resend in{' '}
              <span className="font-semibold tabular-nums" style={{ color: '#41556F' }}>{remaining}s</span>
            </span>
          ) : (
            <button
              type="button"
              onClick={handleResend}
              disabled={verifying}
              className="text-[14px] font-semibold hover:underline focus:outline-none focus-visible:underline disabled:opacity-60 transition-colors"
              style={{ color: '#13294B' }}
            >
              Didn’t arrive? Resend code
            </button>
          )
        )}
        <p className="text-[12px]" style={{ color: '#93A2B4' }}>
          The code expires in 10 minutes.
        </p>
      </div>
    </>
  );

  const actions = onChangeNumber ? (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={onChangeNumber}
        disabled={verifying}
        className="rounded-full px-5 py-[11px] text-[14px] font-semibold transition-colors focus:outline-none focus-visible:underline disabled:opacity-60"
        style={{ color: '#41556F', background: '#F1F5F6' }}
      >
        ← Change number
      </button>
    </div>
  ) : null;

  // Optional render-prop shell — checkout wraps this in its StepShell
  // for consistent step chrome; signup uses the default card.
  if (shell) return <>{shell(body, actions)}</>;

  return (
    <div className="rounded-[20px] border border-[#E5E9F0] bg-white p-6 sm:p-8 shadow-[0_1px_2px_rgba(15,31,58,0.04)] space-y-5">
      {body}
      {actions}
    </div>
  );
}

export { OTP_LENGTH };
