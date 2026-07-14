'use client';

import { useState, useTransition } from 'react';
import { SPECIALTIES } from '@/lib/specialties';
import { submitPublicLead } from './publicLeadAction';

// ─── Public lead capture form ────────────────────────────────────────
//
// Section on /practices. Plain-text suburb (no Places on the public
// page — keeps the anonymous surface light). Honeypot field is
// visually hidden but present in the DOM for bots to fill.

const inp = 'w-full rounded-lg border border-[rgba(19,41,75,.14)] bg-white px-3 py-2 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E]';

export default function PublicLeadForm() {
  const [pending, startTransition] = useTransition();
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function submit(fd: FormData) {
    setErr(null);
    setOk(false);
    startTransition(async () => {
      const res = await submitPublicLead({
        practiceName: String(fd.get('practice_name') ?? ''),
        contactName:  String(fd.get('contact_name') ?? ''),
        phone:        String(fd.get('phone') ?? ''),
        email:        String(fd.get('email') ?? ''),
        specialty:    String(fd.get('specialty') ?? ''),
        suburb:       String(fd.get('suburb') ?? ''),
        message:      String(fd.get('message') ?? ''),
        website:      String(fd.get('website') ?? ''),  // honeypot
      });
      if (res.ok) { setOk(true); return; }
      if (res.error === 'rate_limited') { setErr('Too many submissions — please try again later.'); return; }
      setErr(res.message ?? 'Something went wrong. Please try again.');
    });
  }

  return (
    <section id="get-in-touch" className="band" data-testid="public-lead-form-section">
      <div className="wrap">
        <div className="sec-head reveal">
          <div className="kicker">Get in touch</div>
          <h2>Talk to us about your practice</h2>
          <p>Leave a few details and we&apos;ll come back to you within a day.</p>
        </div>

        {ok ? (
          <div
            role="status"
            data-testid="public-lead-ok"
            className="mx-auto max-w-xl rounded-2xl border border-emerald-200 bg-emerald-50 text-emerald-900 px-4 py-4 text-sm"
          >
            <p className="font-semibold">Thanks — we&apos;ve got your details.</p>
            <p className="mt-1">A member of the betternow team will be in touch shortly.</p>
          </div>
        ) : (
          <form
            action={submit}
            className="mx-auto max-w-xl grid grid-cols-1 sm:grid-cols-2 gap-3"
            data-testid="public-lead-form"
          >
            <label className="text-xs text-gray-700 sm:col-span-2">
              <span className="block font-medium mb-1">Practice name <span className="text-red-500">*</span></span>
              <input required name="practice_name" className={inp} />
            </label>
            <label className="text-xs text-gray-700">
              <span className="block font-medium mb-1">Your name <span className="text-red-500">*</span></span>
              <input required name="contact_name" className={inp} />
            </label>
            <label className="text-xs text-gray-700">
              <span className="block font-medium mb-1">Phone</span>
              <input name="phone" type="tel" className={inp} placeholder="+27 …" />
            </label>
            <label className="text-xs text-gray-700">
              <span className="block font-medium mb-1">Email</span>
              <input name="email" type="email" className={inp} />
            </label>
            <label className="text-xs text-gray-700">
              <span className="block font-medium mb-1">Specialty</span>
              <select name="specialty" className={inp}>
                <option value="">Choose a specialty</option>
                {SPECIALTIES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-700 sm:col-span-2">
              <span className="block font-medium mb-1">Suburb</span>
              <input name="suburb" className={inp} placeholder="e.g. Rosebank" />
            </label>
            <label className="text-xs text-gray-700 sm:col-span-2">
              <span className="block font-medium mb-1">Message (optional)</span>
              <textarea name="message" rows={4} className={inp + ' resize-y'} placeholder="Anything we should know about your practice or patients?" />
            </label>

            {/* Honeypot — hidden from humans, visible to naive bots. */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden
              style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
              data-testid="public-lead-honeypot"
            />

            {err && (
              <p role="alert" className="sm:col-span-2 text-xs rounded-lg border border-red-200 bg-red-50 text-red-800 px-3 py-2">
                {err}
              </p>
            )}

            <div className="sm:col-span-2 flex justify-end">
              <button
                type="submit"
                disabled={pending}
                className="btn btn-primary btn-lg disabled:opacity-60"
                data-testid="public-lead-submit"
              >
                {pending ? 'Sending…' : 'Submit'}
              </button>
            </div>
            <p className="sm:col-span-2 text-[11px] text-gray-500">
              We use these details only to reply to you about betternow. See our privacy notice for how we handle your information.
            </p>
          </form>
        )}
      </div>
    </section>
  );
}
