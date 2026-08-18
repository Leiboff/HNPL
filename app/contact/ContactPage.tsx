import Link from 'next/link';
import SiteHeader from '../_landing/SiteHeader';
import SiteFooter from '../_landing/SiteFooter';
import {
  ADDRESS_LINES,
  HOURS,
  LEGAL_ENTITY,
  PHONE_DISPLAY,
  PHONE_TEL,
  REGISTRATION_NUMBER,
  SUPPORT_EMAIL,
} from '@/lib/config/contact';
import '../landing.css';
import './contact.css';

// ─── /contact — published contact details ───────────────────────────────
//
// A COMPLIANCE page, not a support experience. It exists because an
// acquirer (merchant onboarding) needs to see real, verifiable contact
// details published on the site. That shapes everything about it:
//
//   • It lists WHO we are and HOW to reach us. Nothing else. No contact
//     form, no ticketing, no chat, no FAQ — the landing page already has
//     an FAQ section, and a form here would imply a queue we do not run.
//   • Every detail is a fact, so all of them come from
//     lib/config/contact.ts rather than being typed into this markup.
//   • The registered entity sits alongside the trading name, because that
//     pairing is what an acquirer checks, and it matches the T&Cs and
//     Privacy Policy verbatim.
//
// A SERVER component with no auth client and no data fetch: the route is
// public, and this page is the same bytes for every visitor.
//
// Email and phone are tappable (mailto: / tel:) because this is mostly
// read on a phone — on mobile the whole point is that reaching us is one
// tap, not a copy-paste.
//
// ─── On the legal documents' own copies of the email ──────────────────
//
// app/legal/{terms,privacy} each define a local SUPPORT constant holding
// the same address. Those are deliberately NOT refactored to read from
// lib/config/contact: they are VERSIONED legal instruments with effective
// dates, and their text is what a customer accepted at a point in time
// (profiles.terms_version / plans.terms_version record which). Text inside
// a published version must not change as a side effect of editing a config
// value. The phone number — the volatile detail, and the one this task
// asked to keep in one place — appears only here.

export default function ContactPage() {
  return (
    <div className="lp-root">
      <SiteHeader />

      <main className="lp-contact-wrap">
        <header className="lp-contact-head">
          <h1>Contact us</h1>
          <p className="lp-contact-intro">
            Our contact details, in one place. Reach us any way below and the same
            team answers.
          </p>
        </header>

        <section className="lp-contact-card" aria-labelledby="contact-who">
          <h2 id="contact-who" className="lp-contact-h2">Who we are</h2>
          <p className="lp-contact-entity">
            <span className="brand">
              <span className="lp-b">better</span><span className="lp-n">now</span>
            </span>
            <span className="lp-contact-tradename"> is a trading name of {LEGAL_ENTITY}.</span>
          </p>
          {/* The registration number is the acquirer's actual lookup key,
              so it is rendered as data rather than buried in the sentence. */}
          <dl className="lp-contact-dl">
            <dt>Registered name</dt>
            <dd>{LEGAL_ENTITY}</dd>
            <dt>Registration number</dt>
            <dd>{REGISTRATION_NUMBER}</dd>
          </dl>
        </section>

        <section className="lp-contact-card" aria-labelledby="contact-reach">
          <h2 id="contact-reach" className="lp-contact-h2">How to reach us</h2>

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

            {/* ONE set of hours, for every channel above and below. */}
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
        </section>

        <p className="lp-contact-foot">
          Looking for our <Link href="/legal/terms">Terms &amp; Conditions</Link> or{' '}
          <Link href="/legal/privacy">Privacy Policy</Link>?
        </p>
      </main>

      <SiteFooter />
    </div>
  );
}
