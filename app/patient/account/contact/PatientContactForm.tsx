'use client';

import { useRef, useState } from 'react';
import { usePendingAction } from '@/components/loading/usePendingAction';
import { SUPPORT_EMAIL } from '@/lib/config/contact';
import { submitPatientContactEnquiry, type PatientContactResult } from './actions';

// ─── The message-only half of the patient contact screen ───────────────
//
// name/email/phone/ID are never fields here — the server action reads them
// from the caller's own profile, so there is nothing to show or edit. This
// component's whole job is the message box and the pending/sent/error
// states, mirroring app/contact/ContactForm.tsx's pattern (same hook, same
// "rejection vs. failure result" split — see that file's header for why the
// try/catch lives at the call site).

const COULD_NOT_CONFIRM =
  `We couldn't confirm your message went through. To be safe, please email us directly at ${SUPPORT_EMAIL}.`;

export default function PatientContactForm() {
  const pending = usePendingAction();
  const [sent, setSent]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const fd = new FormData(e.currentTarget);
    const message = String(fd.get('message') ?? '');

    let res: PatientContactResult;
    try {
      res = await pending.run(() => submitPatientContactEnquiry(message));
    } catch {
      setError(COULD_NOT_CONFIRM);
      return;
    }

    if (res.ok) {
      setSent(true);
      formRef.current?.reset();
      return;
    }
    setError(res.message ?? 'Something went wrong. Please try again.');
  }

  if (sent) {
    return (
      <div
        className="rounded-card bg-white p-[18px]"
        style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        data-testid="patient-contact-sent"
      >
        <p className="text-[15px] font-semibold" style={{ color: 'var(--portal-ink)' }}>
          Thanks — your message is on its way.
        </p>
        <p className="mt-1.5 text-[13px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>
          We reply during office hours, usually within one working day. If it&rsquo;s urgent,{' '}
          {SUPPORT_EMAIL} reaches the same inbox.
        </p>
        <button
          type="button"
          onClick={() => setSent(false)}
          data-testid="patient-contact-again"
          className="mt-[14px] text-[13px] font-semibold underline underline-offset-2"
          style={{ color: 'var(--portal-accent-ink)' }}
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <div
      className="rounded-card bg-white p-[18px]"
      style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
    >
      <form ref={formRef} onSubmit={onSubmit} data-testid="patient-contact-form" noValidate>
        <label className="flex flex-col gap-2">
          <span className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.5)' }}>
            What can we help you with?
          </span>
          <textarea
            name="message"
            rows={5}
            required
            className="rounded-tile px-[14px] py-[12px] text-[14px]"
            style={{ border: '1px solid var(--portal-line)', color: 'var(--portal-ink)' }}
            data-testid="patient-contact-message"
          />
        </label>

        {error && (
          <p role="alert" className="mt-3 text-[13px]" style={{ color: '#B42318' }} data-testid="patient-contact-error">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending.disabled}
          data-testid="patient-contact-submit"
          className="mt-[16px] w-full rounded-tile py-[13px] text-[14.5px] font-semibold text-white disabled:opacity-60"
          style={{ background: 'var(--portal-ink)' }}
        >
          {pending.showLabel ? 'Sending…' : 'Send message'}
        </button>
      </form>
    </div>
  );
}
