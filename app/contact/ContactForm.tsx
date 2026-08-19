'use client';

import { useRef, useState } from 'react';
import { usePendingAction } from '@/components/loading/usePendingAction';
import { SUPPORT_EMAIL } from '@/lib/config/contact';
import { submitContactEnquiry } from './contactAction';

// ─── Contact enquiry form ────────────────────────────────────────────
//
// The right-hand card on /contact. A client component inside a statically
// prerendered page: the page stays static because the only server work is
// the action's own POST, so publishing our contact details costs no
// per-request rendering.
//
// ─── PENDING STATE ───────────────────────────────────────────────────
//
// usePendingAction owning its OWN flag, with pending.run() wrapping the call —
// not useTransition. The hook's header explains when each is right:
// useTransition matters when a revalidation follows the action, so the
// button should stay busy until new data is on screen. Nothing revalidates
// here — success swaps this card for a confirmation held in local state —
// so there is no transition to track.
//
// The reason it is pending.run() rather than just reading `disabled`: the hook
// documents that `disabled` is React state, and state updates are async, so
// taps arriving in the SAME TICK all see disabled === false and all get
// through. pending.run() holds a ref, which updates synchronously, and
// collapses a re-entrant call onto the in-flight one. The ref is the guard;
// the disabled attribute is what the user can see.
//
// ─── FAILURE COPY ────────────────────────────────────────────────────
//
// Every failure message comes from the action. On a send failure it states
// that nothing was sent and points at the mailbox directly, because the
// worst outcome here is a visitor who believes they have contacted us and
// waits. No provider error can reach this component — the action replaces
// it with fixed copy and logs the original server-side.

type FieldKey = 'kind' | 'name' | 'email' | 'phone' | 'message';

/**
 * Shown when the call to the action REJECTS rather than returning a result —
 * offline, a dropped connection, a 500 from the action endpoint, a deploy
 * mid-submit.
 *
 * NOTE THE HEDGE, it is the whole point. Every other failure message on this
 * form can say plainly that nothing was sent, because the action returned and
 * told us so. A rejection cannot say that: the request may have reached the
 * server, sent the email, and then lost the connection on the way back. So
 * "nothing was sent" here would be the same class of confident-false-statement
 * as a fake success, merely inverted — and it would invite someone to write
 * again when we already have their message.
 *
 * "Couldn't confirm" is the only honest description of what we know, and the
 * advice that follows is safe under BOTH possibilities: emailing us directly
 * costs a duplicate at worst, and a duplicate is recoverable in a way that
 * silence is not.
 *
 * This copy lives here rather than in contactAction.ts because on this path
 * the action never runs — there is no server response to carry a message.
 */
const COULD_NOT_CONFIRM =
  `We couldn't confirm your message went through. To be safe, please email us directly at ${SUPPORT_EMAIL}.`;

export default function ContactForm() {
  const pending = usePendingAction();
  const [sent, setSent]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<FieldKey | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setField(null);

    const fd = new FormData(e.currentTarget);

    // ── Why this try/catch exists ───────────────────────────────────────
    //
    // usePendingAction's run() is `try { await fn() } finally { … }` — it
    // clears its flag but does NOT swallow the rejection, by design, because
    // the hook manages presentation and leaves failure policy to the caller.
    // Without a catch HERE, a rejection escaped this async handler as an
    // unhandled promise rejection: no error, no success, the button simply
    // re-enabled. The user was left unable to tell whether they had contacted
    // us. That is the one outcome this form exists to prevent.
    //
    // The catch belongs at this call site and NOT in the hook: ~31 other
    // callers share it, several of which deliberately end in a redirect, and
    // a catch there would change failure handling for all of them.
    //
    // The finally in run() has already cleared the pending flag by the time
    // we get here, so the button re-enables and a retry is possible — the
    // catch adds the message, it does not need to unstick anything.
    let res;
    try {
      res = await pending.run(() =>
        submitContactEnquiry({
          kind:    String(fd.get('kind') ?? ''),
          name:    String(fd.get('name') ?? ''),
          email:   String(fd.get('email') ?? ''),
          phone:   String(fd.get('phone') ?? ''),
          message: String(fd.get('message') ?? ''),
          website: String(fd.get('website') ?? ''),   // honeypot
        }),
      );
    } catch {
      // The rejection itself is not surfaced. It is a transport error, not
      // something a visitor can act on, and this form's rule is that no
      // provider or internal error string ever reaches the user.
      setError(COULD_NOT_CONFIRM);
      setField(null);
      return;
    }

    if (res.ok) {
      setSent(true);
      formRef.current?.reset();
      return;
    }
    setError(res.message ?? 'Something went wrong. Please try again.');
    setField(res.field ?? null);
  }

  if (sent) {
    return (
      <div className="lp-contact-card lp-contact-formcard" data-testid="contact-form-card">
        <div role="status" data-testid="contact-form-sent" className="lp-contact-sent">
          <h2 className="lp-contact-sent-title">Thanks — your message is on its way.</h2>
          <p className="lp-contact-sent-body">
            We reply during office hours, usually within one working day. If it is
            urgent, {SUPPORT_EMAIL} reaches the same inbox.
          </p>
          <button
            type="button"
            className="lp-contact-again"
            onClick={() => setSent(false)}
            data-testid="contact-form-again"
          >
            Send another message
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="lp-contact-card lp-contact-formcard" data-testid="contact-form-card">
      <h2 className="lp-contact-formtitle">Send us a message</h2>

      <form ref={formRef} onSubmit={onSubmit} className="lp-contact-form" data-testid="contact-form" noValidate>
        {/* No default is set on purpose. An unset value is honest and the
            server rejects it; a wrong default would quietly mislabel the
            enquiry, which is worse than not labelling it at all. */}
        <fieldset className="lp-contact-seg" data-testid="contact-form-kind">
          <legend className="lp-contact-label">You are a</legend>
          <div className="lp-contact-segrow">
            <label className="lp-contact-segopt">
              <input type="radio" name="kind" value="patient" required />
              <span>Patient</span>
            </label>
            <label className="lp-contact-segopt">
              <input type="radio" name="kind" value="practice" required />
              <span>Practice</span>
            </label>
          </div>
        </fieldset>

        <label className="lp-contact-field">
          <span className="lp-contact-label">Your name</span>
          <input
            name="name"
            autoComplete="name"
            className="lp-contact-input"
            aria-invalid={field === 'name' || undefined}
            data-testid="contact-form-name"
          />
        </label>

        <label className="lp-contact-field">
          <span className="lp-contact-label">Email</span>
          <input
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            className="lp-contact-input"
            aria-invalid={field === 'email' || undefined}
            data-testid="contact-form-email"
          />
        </label>

        <label className="lp-contact-field">
          <span className="lp-contact-label">
            Contact number <span className="lp-contact-optional">(optional)</span>
          </span>
          <input
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className="lp-contact-input"
            aria-invalid={field === 'phone' || undefined}
            data-testid="contact-form-phone"
          />
        </label>

        <label className="lp-contact-field">
          <span className="lp-contact-label">What can we help you with?</span>
          <textarea
            name="message"
            rows={5}
            className="lp-contact-input lp-contact-textarea"
            aria-invalid={field === 'message' || undefined}
            data-testid="contact-form-message"
          />
        </label>

        {/* Honeypot — hidden from humans, visible to naive bots. Same field
            name and same silent-success handling as the /practices form, so
            the two public surfaces cannot be distinguished by probing. */}
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden
          style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
          data-testid="contact-form-honeypot"
        />

        {error && (
          <p role="alert" className="lp-contact-error" data-testid="contact-form-error">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending.disabled}
          className="lp-contact-submit"
          data-testid="contact-form-submit"
        >
          {pending.showLabel ? 'Sending…' : 'Send message'}
        </button>
      </form>
    </div>
  );
}
