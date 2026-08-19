import SiteHeader from '../_landing/SiteHeader';
import SiteFooter from '../_landing/SiteFooter';
import ContactForm from './ContactForm';
import {
  ADDRESS_LINES,
  HOURS,
  PHONE_DISPLAY,
  PHONE_TEL,
  SUPPORT_EMAIL,
} from '@/lib/config/contact';
import '../landing.css';
import './contact.css';

// ─── /contact — reach us, and a form to do it ───────────────────────────
//
// Two columns. LEFT is the human half: the heading, one warm line, and the
// details as plain label/value pairs. RIGHT is a card holding the enquiry
// form. On a narrow viewport they stack with the details FIRST, because
// someone on a phone more often wants to tap the number than type a message.
//
// ─── WHAT THIS PAGE DELIBERATELY DOES NOT CARRY ──────────────────────
//
// • The REGISTERED ENTITY NAME AND REGISTRATION NUMBER. They live in the
//   T&Cs (clause 1.11) and the Privacy Policy (12.1), which is where a
//   reviewer or a regulator looks for them. Carrying them on a contact page
//   is non-standard and reads as boilerplate, and a second copy is a second
//   thing to keep in step with the legal documents. Do not reintroduce them
//   here — a test asserts their absence from this page.
//
// • A "looking for our Terms / Privacy?" line. Both are in the site footer,
//   which is already on this page. Repeating them is filler.
//
// • Any copy explaining the page itself. The previous version opened with
//   "Our contact details, in one place. Reach us any way below and the same
//   team answers." — a sentence that describes the layout rather than saying
//   anything. One warm line inviting contact replaces all of it.
//
// A SERVER component: no auth client and no data fetch, so the route builds
// STATIC. ContactForm is the only client boundary on the page.
//
// ─── On the legal documents' own copies of the email ──────────────────
//
// app/legal/{terms,privacy} each define a local SUPPORT constant holding the
// same address. Those are deliberately NOT refactored to read from
// lib/config/contact: they are VERSIONED legal instruments, and their text is
// what a customer accepted at a point in time (profiles.terms_version /
// privacy_version record which). Text inside a published version must not
// change as a side effect of editing a config value. The phone number — the
// volatile detail — appears only in the config.

export default function ContactPage() {
  return (
    <div className="lp-root">
      <SiteHeader />

      <main className="lp-contact-wrap">
        <div className="lp-contact-grid">

          {/* ── LEFT: the human half ─────────────────────────────── */}
          <div className="lp-contact-intro-col">
            <h1 className="lp-contact-h1">Contact us</h1>
            <p className="lp-contact-lede">
              Whether you are paying off a bill or running a practice, there is a
              real person on the other end. Tell us what you need.
            </p>

            <dl className="lp-contact-dl">
              <dt>Email</dt>
              <dd>
                <a className="lp-contact-link" href={`mailto:${SUPPORT_EMAIL}`}>
                  {SUPPORT_EMAIL}
                </a>
              </dd>

              <dt>Phone</dt>
              <dd>
                <a className="lp-contact-link" href={`tel:${PHONE_TEL}`}>
                  {PHONE_DISPLAY}
                </a>
              </dd>

              {/* ONE set of hours, for every channel on this page. */}
              <dt>Hours</dt>
              <dd>{HOURS}</dd>

              <dt>Address</dt>
              <dd>
                <address className="lp-contact-address">
                  {ADDRESS_LINES.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </address>
              </dd>
            </dl>
          </div>

          {/* ── RIGHT: the form card ─────────────────────────────── */}
          <div className="lp-contact-form-col">
            <ContactForm />
          </div>

        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
