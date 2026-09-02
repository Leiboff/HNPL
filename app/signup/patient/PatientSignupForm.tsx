'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { signUpPatient } from './actions';
import {
  isValidEmail,
  checkPassword,
} from '@/lib/validation';
import {
  useFieldValidation,
  focusAndScrollTo,
  type FieldsSchema,
} from '@/lib/forms/useFieldValidation';
import { usePendingAction } from '@/components/loading/usePendingAction';
import {
  AUTH_LABEL_CLS,
  AUTH_PRIMARY_CLS,
  authInputClass,
  authPrimaryStyle,
} from '@/app/_components/authFormStyles';

// ─── PatientSignupForm — account-only ─────────────────────────────────
//
// After the stepped-onboarding pass, this form collects ONLY the
// fields needed to create the auth user. Phone, SA ID, and salary
// date now belong to the /onboarding flow — captured with a progress
// bar, resumable, gated server-side. Google users skip this form
// entirely and land in /onboarding directly.
//
// The invitation banner + hnpl_invite_token cookie handoff are
// unchanged: a patient arriving here via a practice's checkout link
// still gets their invitation cookie set and processed by the
// middleware after they finish onboarding.
//
// Google is NOT offered here — it is offered on the /signup chooser that
// leads to this form. See the note where that block used to be.

type Invitation = {
  email:        string;
  practiceName: string | null;
};

type Props = {
  invitation?: Invitation | null;
  token?:      string | null;
  /**
   * The agreement collected on the /signup chooser, one screen back —
   * where it now sits under BOTH the email and Google options so a
   * single tick covers whichever the visitor picks.
   *
   * The chooser will not open this form without it, so in practice it is
   * always true here. It is still threaded through to signUpPatient,
   * which keeps its own server-side gate: the tick is a client
   * affordance and a hand-crafted POST can omit it.
   */
  termsAccepted: boolean;
};

// Field styling is the shared dark-surface vocabulary — the same
// height, radius, fill, focus ring and label colour as the email sign-in
// screen on /login and every /onboarding step, so the whole account
// journey is one component vocabulary rather than several designs that
// merely share a background. It lived here as a local copy until the
// onboarding steps needed the same set; see
// app/_components/authFormStyles.ts.
const inputClass = authInputClass;

function FieldLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <label className={AUTH_LABEL_CLS}>
      {label}
      {required && <span aria-hidden className="ml-0.5 text-red-300">*</span>}
    </label>
  );
}

const BLANK = {
  firstName: '',
  lastName:  '',
  email:     '',
  password:  '',
  confirm:   '',
};

type Fields = typeof BLANK;

/** The browser's IANA timezone, or null if it will not say. Never throws. */
function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export default function PatientSignupForm({ invitation, token, termsAccepted }: Props) {
  const [fields, setFields] = useState<Fields>({
    ...BLANK,
    email: invitation?.email ?? '',
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loading,     setLoading]     = useState(false);

  // ─── Automation observations (see lib/security/botSignals.ts) ────────
  //
  // Three cheap facts about HOW this form was filled, not about who filled
  // it. None is stored, none identifies anyone, and all three are scored
  // server-side — the client is not trusted to draw a conclusion, only to
  // report what it saw.
  //
  // `honeypot` is a field CSS hides from people. Named so password
  // managers ignore it: managers fill fields that look like credentials,
  // so this one deliberately does not.
  //
  // `mountedAt` is a client clock and can be lied about; the server treats
  // it as the weak signal it is. It exists because it costs nothing, not
  // because it is trustworthy.
  const [honeypot, setHoneypot] = useState('');
  // 0 = not yet measured. Set in the effect below rather than here:
  // calling Date.now() during render is impure and can produce a value
  // that shifts on an unrelated re-render. A 0 is reported as "no dwell
  // observed" rather than as an impossibly fast one — see the
  // not-observed-is-not-observed-absent rule in lib/security/botSignals.ts.
  const mountedAt = useRef<number>(0);
  const interactions = useRef<number>(0);

  useEffect(() => {
    mountedAt.current = Date.now();
    const bump = () => { interactions.current += 1; };
    // Capture phase so a handler that stops propagation cannot silence the
    // count. passive so nothing here can delay input.
    const opts = { capture: true, passive: true } as const;
    document.addEventListener('keydown',     bump, opts);
    document.addEventListener('pointerdown', bump, opts);
    return () => {
      document.removeEventListener('keydown',     bump, opts);
      document.removeEventListener('pointerdown', bump, opts);
    };
  }, []);
  // Mirrors the flag above for PRESENTATION only — the flag and the call
  // it guards are untouched. pending.disabled follows it immediately
  // (double-tap safety is never delayed); pending.showLabel waits out the
  // flash threshold. See components/loading/usePendingAction.ts.
  const pending = usePendingAction({ pending: loading });

  // Field declaration order = focus-on-submit order.
  const schema = useMemo<FieldsSchema<Fields>>(() => ({
    firstName: { validate: (v) => v.firstName.trim() ? null : 'First name is required.' },
    lastName:  { validate: (v) => v.lastName.trim()  ? null : 'Last name is required.' },
    email:     { validate: (v) => isValidEmail(v.email) ? null : 'Enter a valid email address.' },
    password:  {
      validate: (v) => {
        if (v.password.length < 8) return 'Password must be at least 8 characters.';
        const pwd = checkPassword(v.password, v.email);
        if (!pwd.ok) {
          return pwd.reason === 'contains_email_local_part'
            ? 'Please choose a password that doesn\'t contain your email address.'
            : 'That password is too common. Please choose a less guessable one.';
        }
        return null;
      },
    },
    confirm:   { validate: (v) => v.password !== v.confirm ? 'Passwords don\'t match.' : null },
  }), []);

  const { errors, handleBlur, validateAll } = useFieldValidation(fields, schema);

  function setText(key: keyof Fields) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setFields(f => ({ ...f, [key]: e.target.value }));
  }
  const onBlur = (key: keyof Fields) => () => handleBlur(key);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    const { ok, firstInvalid } = validateAll();
    if (!ok) {
      setSubmitError('Please complete the required fields highlighted below.');
      if (firstInvalid) {
        const id = `patient-${String(firstInvalid)}`;
        requestAnimationFrame(() => focusAndScrollTo(id));
      }
      return;
    }

    setLoading(true);
    const emailTrimmed = fields.email.trim();
    const result = await signUpPatient({
      firstName:     fields.firstName.trim(),
      lastName:      fields.lastName.trim(),
      email:         emailTrimmed,
      password:      fields.password,
      token:         token ?? undefined,
      termsAccepted,
      client: {
        honeypot,
        dwellMs:          mountedAt.current === 0 ? null : Date.now() - mountedAt.current,
        interactionCount: interactions.current,
        timezone:         browserTimezone(),
      },
    });
    setLoading(false);

    if (result.error) {
      setSubmitError(result.error);
      return;
    }

    // Hand off to the onboarding tree. /onboarding/verify-email is
    // reachable pre-session (reads email from ?email= param). After
    // verifyOtp succeeds there, the form hard-navigates to /onboarding,
    // which forwards to the next unfinished step (phone). Every
    // subsequent step lives inside the /onboarding tree with the
    // shared progress bar.
    window.location.href =
      '/onboarding/verify-email?email=' + encodeURIComponent(emailTrimmed);
  }

  return (
    <>
      {invitation && (
        <div className="mb-6 rounded-2xl border border-[var(--auth-hairline)] bg-[var(--auth-fill)] px-4 py-4">
          <p className="text-sm font-medium text-white">
            {invitation.practiceName
              ? `${invitation.practiceName} has sent you a payment plan.`
              : 'You have been sent a payment plan.'}
          </p>
          <p className="mt-0.5 text-sm text-[var(--auth-muted)]">Register to view and accept it.</p>
        </div>
      )}

      {/* No Google option here, deliberately.
          
          This form is reached by choosing "Sign up with email" on the
          /signup chooser, where Google is offered alongside it. Repeating
          it inside the form re-asks a question the visitor has already
          answered, one screen after they answered it — and it was the
          only reason this form imported ContinueWithGoogleButton at all.
          
          The chooser is the one place the methods compete. */}

      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {/* ─── Honeypot ───────────────────────────────────────────────
            Hidden from people, present in the DOM for anything that
            parses HTML and fills inputs. Not `display:none` alone:
            some automation skips those, so it is positioned off-screen
            while remaining a real, focusable-in-DOM field.

            aria-hidden + tabIndex -1 keep it away from screen readers
            and keyboard users — a honeypot that traps assistive
            technology is a honeypot that refuses disabled customers.

            autoComplete="off" and the deliberately unappealing name keep
            password managers out of it. */}
        <div aria-hidden="true" className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
          <label htmlFor="patient-contact-reference">Leave this field empty</label>
          <input
            id="patient-contact-reference"
            name="contact-reference"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel label="First name" required />
            <input
              id="patient-firstName"
              type="text"
              value={fields.firstName}
              onChange={setText('firstName')}
              onBlur={onBlur('firstName')}
              aria-invalid={!!errors.firstName}
              placeholder="Jane"
              className={inputClass(!!errors.firstName)}
            />
            {errors.firstName && <p className="mt-1 text-xs text-red-300">{errors.firstName}</p>}
          </div>
          <div>
            <FieldLabel label="Last name" required />
            <input
              id="patient-lastName"
              type="text"
              value={fields.lastName}
              onChange={setText('lastName')}
              onBlur={onBlur('lastName')}
              aria-invalid={!!errors.lastName}
              placeholder="Smith"
              className={inputClass(!!errors.lastName)}
            />
            {errors.lastName && <p className="mt-1 text-xs text-red-300">{errors.lastName}</p>}
          </div>
        </div>

        <div>
          <FieldLabel label="Email address" required />
          <input
            id="patient-email"
            type="email"
            value={fields.email}
            onChange={invitation ? undefined : setText('email')}
            onBlur={invitation ? undefined : onBlur('email')}
            readOnly={!!invitation}
            aria-invalid={!!errors.email}
            placeholder="jane@example.com"
            className={`${inputClass(!!errors.email)} ${invitation ? 'cursor-not-allowed !bg-white/[.03] !text-[var(--auth-dim)]' : ''}`}
          />
          {errors.email && <p className="mt-1 text-xs text-red-300">{errors.email}</p>}
        </div>

        <div>
          <FieldLabel label="Password" required />
          <input
            id="patient-password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={fields.password}
            onChange={setText('password')}
            onBlur={onBlur('password')}
            aria-invalid={!!errors.password}
            placeholder="At least 8 characters"
            className={inputClass(!!errors.password)}
          />
          {errors.password && <p className="mt-1 text-xs text-red-300">{errors.password}</p>}
        </div>

        <div>
          <FieldLabel label="Confirm password" required />
          <input
            id="patient-confirm"
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={fields.confirm}
            onChange={setText('confirm')}
            onBlur={onBlur('confirm')}
            aria-invalid={!!errors.confirm}
            placeholder="Repeat your password"
            className={inputClass(!!errors.confirm)}
          />
          {errors.confirm && <p className="mt-1 text-xs text-red-300">{errors.confirm}</p>}
        </div>

        {/* The "I agree" tick is NOT here any more. It lives on the
            /signup chooser, one screen back, under both the email and
            Google options — so one tick covers whichever route the
            visitor takes, instead of the email path having its own and
            the Google path having none. Its value arrives as a prop and
            is still gated server-side in signUpPatient. */}

        {submitError && (
          <div className="rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-[13px] leading-[1.55] text-red-200" role="alert">
            {submitError}
          </div>
        )}

        <button
          type="submit"
          disabled={pending.disabled}
          className={AUTH_PRIMARY_CLS}
          style={authPrimaryStyle(pending.disabled)}
        >
          {pending.showLabel ? 'Creating account…' : 'Next'}
        </button>
      </form>

      <p className="mt-8 text-center text-[15px] text-[var(--auth-muted)]">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold" style={{ color: 'var(--auth-accent)' }}>
          Sign in
        </Link>
      </p>
    </>
  );
}
