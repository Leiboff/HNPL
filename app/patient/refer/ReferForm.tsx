'use client';

import { useRef, useState } from 'react';
import { usePendingAction } from '@/components/loading/usePendingAction';
import { referAFriend, referAPractice, type ReferralActionResult } from './actions';

// ─── One form, two referrals ─────────────────────────────────────────────
//
// A friend and a practice are different objects with different fields, and
// they are the same ACT — "someone I know should be on this". Two separate
// cards stacked down the screen would ask a patient to read both before
// deciding which one they are doing; a segmented control asks once.
//
// ─── PENDING STATE ───────────────────────────────────────────────────────
//
// usePendingAction with pending.run(), not useTransition — the same choice
// app/contact/ContactForm.tsx documents at length. Nothing revalidates into
// this component: success swaps the form for a confirmation held in local
// state. run()'s synchronous ref is also the double-submit guard, which
// matters here because both actions SEND SOMETHING on success (an email, or a
// lead into a rep's queue) and `disabled` is React state that two taps in one
// tick both see as false.
//
// ─── ERRORS ──────────────────────────────────────────────────────────────
//
// Every message a person sees comes from the action. No provider error and no
// database error reaches this component: the actions replace them with fixed
// copy and log the original server-side, which is the standing rule in this
// repo after a raw Resend error string once landed on a practice screen.

type Mode = 'friend' | 'practice';

const COULD_NOT_CONFIRM =
  "We couldn't confirm that went through. Please check your referrals below before trying again.";

export default function ReferForm() {
  const pending = usePendingAction();
  const [mode, setMode]       = useState<Mode>('friend');
  const [done, setDone]       = useState<string | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [field, setField]     = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    // A half-typed friend invitation is not a half-typed practice referral.
    setError(null);
    setField(null);
    setDone(null);
    formRef.current?.reset();
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setField(null);

    const fd = new FormData(e.currentTarget);
    const read = (key: string) => String(fd.get(key) ?? '');

    let res: ReferralActionResult;
    try {
      res = await pending.run(() => (mode === 'friend'
        ? referAFriend({ name: read('name'), email: read('email') })
        : referAPractice({
            practiceName: read('practiceName'),
            contactName:  read('contactName'),
            email:        read('practiceEmail'),
            phone:        read('phone'),
            suburb:       read('suburb'),
            note:         read('note'),
          })));
    } catch {
      // A rejection, not a result: offline, a dropped connection, a deploy
      // mid-submit. We cannot say nothing was sent — the request may have
      // reached the server and succeeded on the way to losing the response —
      // so the copy points at the list, which is the one place that knows.
      setError(COULD_NOT_CONFIRM);
      return;
    }

    if (res.ok) {
      setDone(res.message);
      formRef.current?.reset();
      return;
    }
    setError(res.error);
    setField(res.field ?? null);
  }

  if (done) {
    return (
      <section
        className="rounded-card bg-white p-[18px]"
        style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        data-testid="refer-done"
      >
        <p className="text-[15px] font-semibold" style={{ color: 'var(--portal-ink)' }}>{done}</p>
        <button
          type="button"
          onClick={() => setDone(null)}
          data-testid="refer-again"
          className="mt-[14px] text-[13px] font-semibold underline underline-offset-2"
          style={{ color: 'var(--portal-accent-ink)' }}
        >
          Refer someone else
        </button>
      </section>
    );
  }

  return (
    <section
      className="rounded-card bg-white p-[18px]"
      style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
    >
      <div
        role="tablist"
        aria-label="What are you referring?"
        className="flex gap-1 rounded-tile p-1"
        style={{ background: 'rgba(19,41,75,.05)' }}
      >
        {(['friend', 'practice'] as const).map((value) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={mode === value}
            onClick={() => switchMode(value)}
            data-testid={`refer-mode-${value}`}
            className="flex-1 rounded-tile py-[9px] text-[13.5px] font-semibold"
            style={mode === value
              ? { background: '#fff', color: 'var(--portal-ink)', boxShadow: '0 1px 3px rgba(15,31,58,.10)' }
              : { color: 'var(--portal-muted)' }}
          >
            {value === 'friend' ? 'A friend' : 'A practice'}
          </button>
        ))}
      </div>

      <form ref={formRef} onSubmit={onSubmit} className="mt-[16px]" data-testid="refer-form" noValidate>
        {mode === 'friend' ? (
          <div className="flex flex-col gap-[14px]">
            <Field label="Their name" hint="Optional">
              <input name="name" autoComplete="off" className={INPUT} style={INPUT_STYLE} data-testid="refer-friend-name" />
            </Field>
            <Field label="Their email" invalid={field === 'email'}>
              <input
                name="email"
                type="email"
                inputMode="email"
                autoComplete="off"
                required
                className={INPUT}
                style={INPUT_STYLE}
                data-testid="refer-friend-email"
              />
            </Field>
            <p className="text-[12.5px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>
              We&rsquo;ll email them once, saying you thought betternow might help. We don&rsquo;t
              create an account for them and we don&rsquo;t email them again.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-[14px]">
            <Field label="Practice name" invalid={field === 'practiceName'}>
              <input name="practiceName" required className={INPUT} style={INPUT_STYLE} data-testid="refer-practice-name" />
            </Field>
            <Field label="Who to ask for" hint="Optional">
              <input name="contactName" autoComplete="off" className={INPUT} style={INPUT_STYLE} data-testid="refer-practice-contact" />
            </Field>
            <Field label="Their email" invalid={field === 'email'}>
              <input
                name="practiceEmail"
                type="email"
                inputMode="email"
                autoComplete="off"
                className={INPUT}
                style={INPUT_STYLE}
                data-testid="refer-practice-email"
              />
            </Field>
            <Field label="Their phone" invalid={field === 'phone'}>
              <input
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                className={INPUT}
                style={INPUT_STYLE}
                data-testid="refer-practice-phone"
              />
            </Field>
            <Field label="Suburb or town" hint="Optional">
              <input name="suburb" autoComplete="off" className={INPUT} style={INPUT_STYLE} data-testid="refer-practice-suburb" />
            </Field>
            <Field label="Anything we should know?" hint="Optional">
              <textarea name="note" rows={3} className={INPUT} style={INPUT_STYLE} data-testid="refer-practice-note" />
            </Field>
            <p className="text-[12.5px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>
              One of our team will get in touch with them. We won&rsquo;t mention your name
              unless you ask us to in the note.
            </p>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 text-[13px]" style={{ color: '#B42318' }} data-testid="refer-error">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending.disabled}
          data-testid="refer-submit"
          className="mt-[16px] w-full rounded-tile py-[13px] text-[14.5px] font-semibold text-white disabled:opacity-60"
          style={{ background: 'var(--portal-ink)' }}
        >
          {pending.showLabel
            ? 'Sending…'
            : mode === 'friend' ? 'Send invitation' : 'Refer this practice'}
        </button>
      </form>
    </section>
  );
}

const INPUT = 'rounded-tile px-[14px] py-[12px] text-[14px] w-full';
const INPUT_STYLE = { border: '1px solid var(--portal-line)', color: 'var(--portal-ink)' } as const;

function Field({
  label, hint, invalid, children,
}: {
  label: string;
  hint?: string;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span
        className="flex items-baseline gap-2 text-[11px] font-semibold uppercase"
        style={{ letterSpacing: '.14em', color: invalid ? '#B42318' : 'rgba(19,41,75,.5)' }}
      >
        {label}
        {hint && (
          <span className="font-normal normal-case" style={{ letterSpacing: 0, color: 'var(--portal-muted)' }}>
            {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}
