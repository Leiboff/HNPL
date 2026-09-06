'use client';

import { useRef, useState } from 'react';
import { usePendingAction } from '@/components/loading/usePendingAction';
import { referAFriend, referAPractice, type ReferralActionResult } from './actions';
import type { ReferMode } from './ReferTabs';

// ─── One form, two referrals ─────────────────────────────────────────────
//
// Which one is showing is decided by ReferTabs, which owns the toggle and
// remounts this component on a switch (`key={mode}`), so there is no reset
// logic here and no state that can survive a change of mind.
//
// ─── THE PRACTICE SIDE IS A LEAD FORM ────────────────────────────────────
//
// Worth saying plainly, because the two halves look alike and are not:
//
//   friend    → an email invitation, one row in `referrals`, and a code the
//               invitee carries into their own signup.
//   practice  → a row in `crm_leads` with source='referral', which a rep
//               works through the pipeline that already exists, plus the
//               `referrals` row that points at it. Nothing is emailed to the
//               practice by this form, and there is no link to share with
//               them: a practice does not self-serve.
//
// That is why the fields differ so much. The friend side collects the one
// thing needed to send an invitation; the practice side collects what a
// person on the phone will need — who to ask for, where they are, and why
// the patient thought of them.
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

const COULD_NOT_CONFIRM =
  "We couldn't confirm that went through. Please check your referrals below before trying again.";

export default function ReferForm({ mode }: { mode: ReferMode }) {
  const pending = usePendingAction();
  const [done, setDone]   = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

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
      <p
        className="text-[11px] font-semibold uppercase"
        style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.45)' }}
      >
        {mode === 'friend' ? 'Invite them by email' : 'Tell us about the practice'}
      </p>

      <form ref={formRef} onSubmit={onSubmit} className="mt-[14px]" data-testid="refer-form" noValidate>
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
              This goes to our team as a new lead, not to the practice. One of us will get
              in touch with them — we won&rsquo;t mention your name unless you ask us to in
              the note.
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
