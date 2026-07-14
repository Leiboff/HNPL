'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import SiteHeader from '../_landing/SiteHeader';
import SiteFooter from '../_landing/SiteFooter';
import {
  CashIcon,
  ShieldCheckIcon,
  PeopleIcon,
} from '../_landing/icons';
import PublicLeadForm from './PublicLeadForm';
import '../landing.css';

// ─── /practices — provider-facing marketing page ───────────────────────
//
// Everything the old landing #practices section carried, restructured
// as a standalone page with its own compact hero. Same brand chrome,
// same shared header + footer as the patient landing.

export default function PracticesPage() {
  // Scroll-reveal, same discipline as the landing page.
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      }),
      { threshold: 0.12 },
    );
    document.querySelectorAll('.lp-root .reveal').forEach(el => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="lp-root">

      <SiteHeader />

      {/* ── Compact hero ─────────────────────────────────────────────────── */}
      <div className="stage stage-compact">
        <div className="wrap hero">
          <h1>
            <span className="wordmark">
              <span className="lp-b">better</span><span className="lp-n">now</span>
            </span>
            <span style={{ marginLeft: '.4em', color: 'var(--navy)' }}> for practices</span>
          </h1>
          <p className="tagline">
            Turn shortfalls into treatments that go ahead.
          </p>
          <p className="sub">
            Get paid upfront and add zero risk or admin to your day — by letting patients spread their shortfall, interest-free.
          </p>
          <div className="ctas">
            <Link className="btn btn-primary btn-lg" href="/signup/practice">Offer betternow at your practice</Link>
          </div>
        </div>
      </div>

      {/* ── How it works — vertical timeline + R3,600 stats panel ───────── */}
      <section id="how" className="practice-band">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="kicker">How it works</div>
            <h2>Three steps to a paid bill.</h2>
            <p>Record the bill. Patient chooses Pay in 2 or Pay in 3. You get paid upfront — we handle the rest.</p>
          </div>

          <div className="how-two-col">
            <ol className="timeline reveal">
              <li className="tl-step">
                <div className="tl-num">1</div>
                <div className="tl-body">
                  <h3>Record the bill</h3>
                  <p>Capture the patient&apos;s shortfall in seconds. No portals to log into, no forms to file, no debtors to chase.</p>
                </div>
              </li>
              <li className="tl-step">
                <div className="tl-num">2</div>
                <div className="tl-body">
                  <h3>Patient pays in 2 or 3</h3>
                  <p>They split it into interest-free instalments charged automatically to their card, timed to their salary dates. No lengthy approvals.</p>
                </div>
              </li>
              <li className="tl-step">
                <div className="tl-num">3</div>
                <div className="tl-body">
                  <h3>Get paid upfront</h3>
                  <p>Get paid within days — we keep a small percentage as our fee and handle everything else. We collect every instalment and run the whole process, so chasing payment is never your job again.</p>
                </div>
              </li>
            </ol>

            <div className="how-visual reveal">
              <div className="stats-panel">
                <div className="lead">On a R3,600 shortfall</div>
                <div className="stats-grid">
                  <div className="chip"><div className="amt">Days</div><div className="lbl">to get paid</div></div>
                  <div className="chip"><div className="amt">R0</div><div className="lbl">to chase</div></div>
                  <div className="chip"><div className="amt">0 min</div><div className="lbl">admin</div></div>
                </div>
                <div className="note">You receive the bill amount less a small fee. We collect all instalments after you&apos;ve been paid — collection is on us.</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 3 benefit cards (Payflex pattern) ────────────────────────────── */}
      <section id="benefits">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="kicker">Why practices choose betternow</div>
            <h2>Three reasons it works.</h2>
          </div>
          <div className="lp-grid why-grid">
            <div className="feature reveal">
              <div className="ic"><CashIcon /></div>
              <h4>Paid upfront</h4>
              <p>Stop waiting 30–90 days for shortfalls. The bulk of the bill hits your account within days.</p>
            </div>
            <div className="feature reveal">
              <div className="ic"><ShieldCheckIcon /></div>
              <h4>Collection is on us</h4>
              <p>Once you&apos;re paid, the entire collection process is ours. If a patient misses a payment, chasing it is our job — not yours.</p>
            </div>
            <div className="feature reveal">
              <div className="ic"><PeopleIcon /></div>
              <h4>More patients say yes</h4>
              <p>When cost stops being the barrier, more recommended treatments go ahead. Better care, fuller books.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Specialties (moved from landing — provider-targeting content) ── */}
      <section id="specialties" className="band">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="kicker">Specialties</div>
            <h2>Built for South African healthcare.</h2>
          </div>
          <div className="specialty-pills reveal">
            <span className="pill">Dental</span>
            <span className="pill">Optometry</span>
            <span className="pill">Audiology</span>
            <span className="pill">Physiotherapy</span>
            <span className="pill">GP &amp; Family</span>
            <span className="pill">Specialists</span>
            <span className="pill">Dermatology</span>
            <span className="pill">Fertility</span>
          </div>
          <p className="specialty-note reveal">
            If your patients face out-of-pocket shortfalls, betternow fits.{' '}
            Don&apos;t see your field?{' '}
            <a href="mailto:hello@betternow.co.za" style={{ color: 'var(--teal)' }}>Get in touch.</a>
          </p>
        </div>
      </section>

      {/* ── FAQ (practice — fee moved here from landing; fold-ins from
             trimmed benefit cards) ───────────────────────────────────────── */}
      <section id="faq">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="kicker">Questions</div>
            <h2>Practice questions</h2>
          </div>
          <div className="faq">
            <details className="q reveal"><summary>What does it cost my practice?<span className="pm" /></summary><div className="a">You receive the bill upfront, less a small percentage we keep as our fee for running collection and carrying the process. The exact fee depends on your practice — get in touch and we&apos;ll walk you through your terms.</div></details>
            <details className="q reveal"><summary>Is there any paperwork or portals to manage?<span className="pm" /></summary><div className="a">Zero paperwork. Record a bill in seconds — no portals to log into, no statements to reconcile, no debtors to chase. We run collection end-to-end so your admin stays at zero minutes.</div></details>
            <details className="q reveal"><summary>How long does onboarding take?<span className="pm" /></summary><div className="a">Under 30 seconds. No hardware, no integration headache — set up and start offering instalments to patients fast.</div></details>
            <details className="q reveal"><summary>Is betternow built for South African practices?<span className="pm" /></summary><div className="a">Yes. Made for South African billing, salary cycles and patients — from dental and optometry to physio, GPs, specialists, dermatology and fertility.</div></details>
            <details className="q reveal"><summary>When do I get paid?<span className="pm" /></summary><div className="a">Within days of the patient accepting their plan and their first instalment being collected. We keep a small percentage as our fee; you receive the bill amount less that fee.</div></details>
            <details className="q reveal"><summary>Who handles it if a patient misses a payment?<span className="pm" /></summary><div className="a">We do. Once you&apos;re paid upfront, the entire collection process is ours. Chasing missed payments is never your job again.</div></details>
          </div>
        </div>
      </section>

      {/* ── Public lead capture form (Phase 2) ──────────────────────────── */}
      <PublicLeadForm />

      {/* ── Final CTA ────────────────────────────────────────────────────── */}
      <section>
        <div className="wrap">
          <div className="final reveal">
            <h2>Turn shortfalls into treatments.</h2>
            <p>Get paid upfront. Add zero admin. Let more of your recommended treatments go ahead.</p>
            <div className="ctas">
              <Link className="btn btn-primary btn-lg" href="/signup/practice">Offer betternow at your practice</Link>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />

    </div>
  );
}
