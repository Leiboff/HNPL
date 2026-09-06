'use client';

import { useState } from 'react';
import { usePendingAction } from '@/components/loading/usePendingAction';
import PlacesAutocomplete from '@/app/_components/PlacesAutocomplete';
import SpecialtyOptions from '@/components/SpecialtyOptions';
import { parseAddressComponents } from '@/lib/maps/places';
import { referADoctor, type ReferDoctorAddress, type ReferralActionResult } from './actions';

// ─── Refer a doctor — a lead form, and nothing else ──────────────────────
//
// The other half of this screen is a link. This half cannot be, and the
// asymmetry is the whole design: a friend signs themselves up, so a code
// carried into their signup is the entire mechanism. A practice does not
// self-serve. There is no signup a code could be carried into and a link
// handed to a receptionist leads nowhere, so what this form produces is a
// LEAD — a crm_leads row with source='referral' that a rep picks up and
// works, plus the referrals row that points at it.
//
// Migration 0145 says the same thing one layer down: the
// referrals_link_is_patient_only constraint refuses a practice referral with
// channel='link', so offering a share affordance here would be offering
// something the database would reject.
//
// ─── THE FOUR COMPULSORY FIELDS ──────────────────────────────────────────
//
//   Name        who the rep asks for.
//   Specialty   the shared register (lib/specialties.ts) via SpecialtyOptions
//               — the SAME dropdown the CRM's own new-lead form, practice
//               signup and the public lead form use. A local list here would
//               be the exact drift that module exists to prevent.
//   Phone       the rep's next action. Landlines are fine; a switchboard is
//               usually the right number for rooms.
//   Address     picked from Google Places, through the shared
//               PlacesAutocomplete — the same component and the same session-
//               token economics as every other address field in the app.
//               This is what makes the lead findable, dedupable and mappable.
//
// Practice name, email and a note are genuinely optional. A patient knows
// their doctor's name; they very often do not know what the rooms trade as,
// and demanding it was the most refusable field on the version of this form
// that asked for a practice first.
//
// ─── ADDRESS IS THE ONE FIELD THE BROWSER CANNOT VALIDATE ────────────────
//
// PlacesAutocomplete only reports a place once it has been CHOSEN from the
// dropdown, so text that was typed and never picked never reaches this
// component's state. `required` on the input would therefore pass on typed
// rubbish and fail on a perfectly good pick, so the check is ours: an
// explicit hint under the field, a guard in onSubmit, and referADoctor
// refusing it again server-side.
//
// ─── PENDING STATE ───────────────────────────────────────────────────────
//
// usePendingAction with pending.run(), not useTransition — the same choice
// app/contact/ContactForm.tsx documents at length. Nothing revalidates into
// this component: success swaps the form for a confirmation held in local
// state. run()'s synchronous ref is also the double-submit guard, which
// matters here because a success puts a lead into a rep's queue and
// `disabled` is React state that two taps in one tick both see as false.
//
// ─── ERRORS ──────────────────────────────────────────────────────────────
//
// Every message a person sees comes from the action. No provider error and no
// database error reaches this component: the action replaces them with fixed
// copy and logs the original server-side, which is the standing rule in this
// repo after a raw Resend error string once landed on a practice screen.

const COULD_NOT_CONFIRM =
  "We couldn't confirm that went through. Please check your referrals below before trying again.";

const BLANK_ADDRESS: ReferDoctorAddress = {
  formattedAddress: '',
  streetAddress:    null,
  suburb:           null,
  city:             null,
  province:         null,
  latitude:         null,
  longitude:        null,
};

export default function ReferDoctorForm() {
  const pending = usePendingAction();
  const [done,  setDone]  = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);

  // Controlled rather than read off a FormData on submit, because the address
  // is not an input at all — it is the result of a Places pick — and mixing
  // one controlled field into an uncontrolled form is how a reset ends up
  // clearing five things and leaving the sixth behind.
  const [f, setF] = useState({
    doctorName:   '',
    specialty:    '',
    phone:        '',
    practiceName: '',
    email:        '',
    note:         '',
    address:      BLANK_ADDRESS,
  });

  function upd<K extends keyof typeof f>(key: K, value: (typeof f)[K]) {
    setF(prev => ({ ...prev, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setField(null);

    // Client-side first so the message is instant and points at a field. Each
    // of these is refused again by referADoctor — a Server Action is an HTTP
    // endpoint, and this form is a screen the caller owns.
    if (!f.doctorName.trim()) {
      setError("Tell us the doctor's name."); setField('doctorName'); return;
    }
    if (!f.specialty) {
      setError('Choose a specialty from the list.'); setField('specialty'); return;
    }
    if (!f.phone.trim()) {
      setError('Add a phone number so we can reach them.'); setField('phone'); return;
    }
    if (!f.address.formattedAddress) {
      setError('Pick their address from the suggestions.'); setField('address'); return;
    }

    let res: ReferralActionResult;
    try {
      res = await pending.run(() => referADoctor({
        doctorName:   f.doctorName,
        specialty:    f.specialty,
        phone:        f.phone,
        address:      f.address,
        practiceName: f.practiceName,
        email:        f.email,
        note:         f.note,
      }));
    } catch {
      // A rejection, not a result: offline, a dropped connection, a deploy
      // mid-submit. We cannot say nothing was sent — the request may have
      // reached the server and succeeded on the way to losing the response —
      // so the copy points at the list, which is the one place that knows.
      setError(COULD_NOT_CONFIRM);
      return;
    }

    if (res.ok) { setDone(res.message); return; }
    setError(res.error);
    setField(res.field ?? null);
  }

  if (done) {
    return (
      <section className={CARD} style={CARD_STYLE} data-testid="refer-done">
        <p className="text-[15px] font-semibold" style={{ color: 'var(--portal-ink)' }}>{done}</p>
        <button
          type="button"
          onClick={() => {
            // A fresh form, including the address. The Places input holds its
            // own text and has been unmounted for as long as this confirmation
            // has been showing, so it comes back empty on its own — this only
            // has to clear the state that outlived it.
            setF({
              doctorName: '', specialty: '', phone: '', practiceName: '',
              email: '', note: '', address: BLANK_ADDRESS,
            });
            setDone(null);
          }}
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
    <section className={CARD} style={CARD_STYLE}>
      <p
        className="text-[11px] font-semibold uppercase"
        style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.45)' }}
      >
        Tell us about the doctor
      </p>

      <form onSubmit={onSubmit} className="mt-[14px] flex flex-col gap-[14px]" data-testid="refer-form" noValidate>
        <Field label="Doctor’s name" invalid={field === 'doctorName'}>
          <input
            value={f.doctorName}
            onChange={e => upd('doctorName', e.target.value)}
            autoComplete="off"
            placeholder="Dr A Naidoo"
            className={INPUT}
            style={INPUT_STYLE}
            data-testid="refer-doctor-name"
          />
        </Field>

        <Field label="Specialty" invalid={field === 'specialty'}>
          <select
            value={f.specialty}
            onChange={e => upd('specialty', e.target.value)}
            className={INPUT}
            style={INPUT_STYLE}
            data-testid="refer-doctor-specialty"
          >
            <SpecialtyOptions placeholder="Select a specialty" />
          </select>
        </Field>

        <Field label="Their phone number" invalid={field === 'phone'}>
          <input
            value={f.phone}
            onChange={e => upd('phone', e.target.value)}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="011 555 1234"
            className={INPUT}
            style={INPUT_STYLE}
            data-testid="refer-doctor-phone"
          />
        </Field>

        <Field label="Their address" invalid={field === 'address'}>
          <PlacesAutocomplete
            variant="address"
            inputId="refer-doctor-address"
            placeholder="Start typing — we’ll suggest matches"
            onSelect={(place) => {
              const parsed = parseAddressComponents(place.addressComponents);
              upd('address', {
                formattedAddress: place.formattedAddress,
                streetAddress:    parsed.addressLine1 ?? place.formattedAddress,
                suburb:           parsed.suburb,
                city:             parsed.city,
                province:         parsed.province,
                latitude:         place.latitude,
                longitude:        place.longitude,
              });
              if (field === 'address') { setField(null); setError(null); }
            }}
          />
          <p
            className="mt-1.5 text-[12.5px] leading-[1.5]"
            style={{ color: f.address.formattedAddress ? 'var(--portal-ink)' : 'var(--portal-muted)' }}
            data-testid="refer-doctor-address-state"
          >
            {f.address.formattedAddress
              ? `Picked: ${f.address.formattedAddress}`
              : 'Pick a suggestion from the dropdown to attach the address.'}
          </p>
        </Field>

        <Field label="Practice name" hint="Optional">
          <input
            value={f.practiceName}
            onChange={e => upd('practiceName', e.target.value)}
            autoComplete="off"
            className={INPUT}
            style={INPUT_STYLE}
            data-testid="refer-doctor-practice"
          />
        </Field>

        <Field label="Their email" hint="Optional" invalid={field === 'email'}>
          <input
            value={f.email}
            onChange={e => upd('email', e.target.value)}
            type="email"
            inputMode="email"
            autoComplete="off"
            className={INPUT}
            style={INPUT_STYLE}
            data-testid="refer-doctor-email"
          />
        </Field>

        <Field label="Anything we should know?" hint="Optional">
          <textarea
            value={f.note}
            onChange={e => upd('note', e.target.value)}
            rows={3}
            className={INPUT}
            style={INPUT_STYLE}
            data-testid="refer-doctor-note"
          />
        </Field>

        <p className="text-[12.5px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>
          This goes to our team as a new lead, not to the practice. One of us will get
          in touch with them — we won&rsquo;t mention your name unless you ask us to in
          the note.
        </p>

        {error && (
          <p role="alert" className="text-[13px]" style={{ color: '#B42318' }} data-testid="refer-error">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending.disabled}
          data-testid="refer-submit"
          className="mt-[2px] w-full rounded-tile py-[13px] text-[14.5px] font-semibold text-white disabled:opacity-60"
          style={{ background: 'var(--portal-ink)' }}
        >
          {pending.showLabel ? 'Sending…' : 'Refer this doctor'}
        </button>
      </form>
    </section>
  );
}

const CARD = 'rounded-card bg-white p-[18px]';
const CARD_STYLE = {
  border: '1px solid rgba(19,41,75,.06)',
  boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)',
} as const;

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
