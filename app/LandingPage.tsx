'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import SiteHeader from './_landing/SiteHeader';
import SiteFooter from './_landing/SiteFooter';
import { splitInstalments } from '@/lib/finance';
import { formatRand } from './patient/_format';
import './landing.css';

// ─── Landing page — patient audience only ──────────────────────────────
//
// v4 layout (Sep 2026), built from the "betternow landing concept":
// mint hero with a consultation photo, an overlapping proof card, colour-
// blocked reason cards, the real app screenshot beside an accordion of
// steps, a "what you'll need" grid, a navy bill calculator, a two-column
// FAQ and a navy closing band. Everything is scoped under .lp-v4 in
// landing.css, so the SHARED SiteHeader / SiteFooter / .lp-root base that
// /practices, /contact, /legal/* and the auth surfaces render through is
// untouched.
//
// This file is the SINGLE-AUDIENCE landing page. Provider-facing content
// lives on /practices; the header + footer link there. The legacy in-page
// #practices anchor is deliberately dropped — bookmarks that included it
// are redirected to /practices by the hash-redirect effect below.
//
// Copy rule carried over from the concept: the interest promise is
// unconditional (no interest is ever charged), but the FEE promise is
// conditional on paying on time — the patient T&Cs carry a capped default
// fee, so "no fees" is never stated without "when you pay on time".

// Relative timing labels for the calculator. Deliberately NOT real dates —
// the real schedule comes from the patient's chosen salary_day
// (lib/salaryDates.ts) at checkout.
const WHEN = ['Today', 'Next payday', 'The payday after'];

// Calculator bounds. The ceiling is an illustration, not a promise — what a
// patient can actually spend is their approved allowance, which the note
// under the calculator says in plain words.
const CALC_MIN = 500;
const CALC_MAX = 20000;
const CALC_STEP = 500;

// "R3,000" for whole Rands, "R166.68" when there are cents — the portal's
// deterministic formatter (no toLocaleString, so server and browser render
// identical strings), minus the trailing ".00" on whole amounts.
function rands(n: number): string {
  return formatRand(n).replace(/\.00$/, '');
}

const STEPS = [
  {
    title: 'Apply online',
    body: 'Have your ID and card ready. We do a quick credit and affordability check and show you the healthcare allowance you qualify for.',
  },
  {
    title: 'Use betternow at the practice',
    body: 'Scan the betternow QR code at reception or tap the payment link the practice sends you. Pay the first third when you accept the plan.',
  },
  {
    title: 'Pay the next two thirds',
    body: 'Each instalment is charged to your saved card automatically on the date you chose. Pay early any time, free.',
  },
];

export default function LandingPage() {
  // Calculator — presentational only (no fetch, no persistence). The split
  // is the SAME function checkout uses (lib/finance.ts splitInstalments):
  // equal instalments, the first absorbs the rounding remainder, and the
  // total never differs from the bill. Pay in 3 is the only plan offered.
  const [bill, setBill] = useState(3000);
  const instalments = splitInstalments(bill, 3);

  // How-it-works accordion: exactly one step open at a time.
  const [openStep, setOpenStep] = useState(0);

  // Old #practices anchor → /practices. Handles bookmarks and any
  // external link that used the old fragment.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash === '#practices') {
      window.location.replace('/practices');
    }
  }, []);

  // Scroll-reveal IntersectionObserver
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
    <div className="lp-root lp-v4">

      <SiteHeader />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="l4-hero">
        <div className="wrap l4-hero-grid">
          <div className="l4-hero-copy">
            <span className="l4-eyebrow"><span className="l4-pulse" aria-hidden="true" />Interest-free healthcare payments</span>
            <h1>
              Get treated today.{' '}
              <em>Pay in 3.</em>
            </h1>
            <p className="l4-hero-sub">
              Dentist, optometrist, specialist, vet, pharmacy — pay a third today and the rest over your next two paydays. No interest, and no fees when you pay on time.
            </p>
            <div className="l4-hero-ctas">
              <Link className="l4-btn l4-btn-navy" href="/signup">See what I qualify for <span aria-hidden="true">↗</span></Link>
              {/* Plain <a>, not next/link's <Link> — same-page hash
                  navigation via Link is a documented App Router no-op
                  (see SiteHeader.tsx), so this silently failed to scroll
                  to #how while already on /. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberate, see comment above */}
              <a className="l4-play" href="/#how"><span className="l4-play-dot" aria-hidden="true">▶</span>See how it works</a>
            </div>
          </div>
          <div className="l4-hero-visual">
            <Image
              className="l4-hero-photo"
              src="/marketing/hero-reception.webp"
              alt="A patient smiling at her phone at a practice reception desk while the receptionist helps her"
              width={1536}
              height={1024}
              sizes="(max-width: 900px) 100vw, 560px"
              preload
            />
            <span className="l4-photo-note"><b>Healthcare now.</b> Payments over payday.</span>
          </div>
        </div>
      </div>

      {/* ── Proof card + where to use it ─────────────────────────────────── */}
      <div className="l4-proof-wrap">
        <div className="wrap">
          <div className="l4-proof">
            <div><b>0%</b><span>Interest, always</span></div>
            <i aria-hidden="true" />
            <div><b>3</b><span>Equal payments</span></div>
            <i aria-hidden="true" />
            <div><b>1 min</b><span>Online application</span></div>
          </div>
          <div className="l4-uses">
            <b>Use it for</b>
            <ul>
              <li>Dental</li><li>Optometry</li><li>Specialists</li><li>Pharmacy</li><li>Veterinary</li>
            </ul>
          </div>
        </div>
      </div>

      {/* ── Why betternow — exactly 3 reason cards ─────────────────────── */}
      <section id="why" className="l4-why">
        <div className="wrap">
          <div className="l4-kicker">Why betternow</div>
          <div className="l4-why-head reveal">
            <h2>Use your allowance. <span>Split the bill.</span></h2>
            <div>
              <p className="l4-lead">Once you&apos;re approved, you get an interest-free healthcare allowance you can use at any betternow practice.</p>
              <p>Pay a third when you accept the plan. The next two payments are charged to your card on the salary dates you choose.</p>
            </div>
          </div>
          <div className="l4-cards">
            <article className="l4-card l4-card-navy reveal">
              <span className="l4-card-ic" aria-hidden="true">0%</span>
              <h3>Always interest-free</h3>
              <p>No interest, ever. Pay each instalment on its due date and you repay exactly your bill — never a cent more, and no fees.</p>
            </article>
            <article className="l4-card l4-card-mint reveal">
              <span className="l4-card-ic" aria-hidden="true">⅓</span>
              <h3>Three simple payments</h3>
              <p>Pay a third today, then two equal payments timed to your salary dates. Pay early any time, free.</p>
            </article>
            <article className="l4-card l4-card-sky reveal">
              <span className="l4-card-ic" aria-hidden="true">↗</span>
              <h3>1-minute approval</h3>
              <p>Get approved online in 1 minute. No paperwork, no branch visits.</p>
            </article>
          </div>
        </div>
      </section>

      {/* ── How it works — real app screenshot + one-open accordion ─────── */}
      <section id="how" className="l4-how">
        <div className="wrap l4-how-grid">
          <div className="l4-phone-stage reveal">
            <div className="l4-orbit" aria-hidden="true" />
            <Image
              className="l4-device"
              src="/marketing/device-approved.png"
              alt="betternow app showing an approved interest-free healthcare allowance"
              width={630}
              height={1290}
              sizes="300px"
            />
          </div>
          <div className="l4-how-copy">
            <div className="l4-kicker">How it works</div>
            <h2>A bill of health <span>you can afford.</span></h2>
            <p className="l4-how-sub">Health can&apos;t wait. Payments can.</p>
            <ol className="l4-steps">
              {STEPS.map((s, i) => (
                <li key={s.title} className={openStep === i ? 'open' : undefined}>
                  <button
                    type="button"
                    aria-expanded={openStep === i}
                    aria-controls={`l4-step-${i}`}
                    onClick={() => setOpenStep(i)}
                  >
                    <b>0{i + 1}</b>
                    <span>{s.title}</span>
                    <i aria-hidden="true">{openStep === i ? '−' : '+'}</i>
                  </button>
                  <p id={`l4-step-${i}`} hidden={openStep !== i}>{s.body}</p>
                </li>
              ))}
            </ol>
            <Link className="l4-arrow" href="/signup">Check my allowance <span aria-hidden="true">→</span></Link>
          </div>
        </div>
      </section>

      {/* ── What you'll need ────────────────────────────────────────────── */}
      <section id="requirements" className="l4-reqs">
        <div className="wrap">
          <div className="l4-reqs-head reveal">
            <div>
              <div className="l4-kicker">Getting started</div>
              <h2>What you&apos;ll need.</h2>
            </div>
            <p>Give your health some credit — it&apos;s due. The application takes about 1 minute; have these ready before you start.</p>
          </div>
          <div className="l4-req-grid">
            <article className="reveal"><span aria-hidden="true">18+</span><div><h3>Be 18 or older</h3><p>With a good credit record.</p></div></article>
            <article className="reveal"><span aria-hidden="true">ID</span><div><h3>Your South African ID</h3><p>We use it to verify your identity.</p></div></article>
            <article className="reveal"><span aria-hidden="true">✓</span><div><h3>A debit or credit card</h3><p>Visa or Mastercard. Your instalments are charged to it automatically.</p></div></article>
            <article className="reveal"><span aria-hidden="true">1m</span><div><h3>1 minute</h3><p>For a quick credit and affordability check.</p></div></article>
          </div>
          <div className="l4-secure"><b>Your information stays private.</b><span>Encrypted and handled in line with POPIA. We never sell your information.</span></div>
        </div>
      </section>

      {/* ── Calculator — slider, Pay in 3 ───────────────────────────────── */}
      <section className="l4-calc-sec">
        <div className="wrap">
          <div className="l4-calc reveal">
            <div className="l4-calc-copy">
              <div className="l4-kicker l4-kicker-light">Try an amount</div>
              <h2>Pay your bill <span>in smaller doses.</span></h2>
              <p>Move the slider to see how a bill splits into three equal, interest-free payments.</p>
            </div>
            <div className="l4-calc-card">
              <label className="l4-bill" htmlFor="l4-bill-range">
                <span>Your healthcare bill</span>
                <strong>{rands(bill)}</strong>
              </label>
              <input
                id="l4-bill-range"
                type="range"
                min={CALC_MIN}
                max={CALC_MAX}
                step={CALC_STEP}
                value={bill}
                onChange={(e) => setBill(Number(e.target.value))}
                aria-valuetext={rands(bill)}
              />
              <div className="l4-range-ends" aria-hidden="true"><span>{rands(CALC_MIN)}</span><span>{rands(CALC_MAX)}</span></div>
              <div className="l4-plan"><b>Pay in 3</b><small>Three equal, interest-free payments</small></div>
              <div className="l4-pays l4-pays-3" aria-live="polite">
                {instalments.map((amt, k) => (
                  <div key={k}><small>{WHEN[k]}</small><b>{rands(amt)}</b></div>
                ))}
              </div>
              <div className="l4-total">
                <span>Total you pay</span>
                <strong>{rands(bill)} <small>0% interest</small></strong>
              </div>
              <p className="l4-calc-note">Illustration only. What you can spend depends on your approved allowance, and your dates on the salary day you choose. If a bill is more than your available allowance, the difference is added to your first payment.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── FAQ (patient-only) ──────────────────────────────────────────── */}
      <section id="faq" className="l4-faq">
        <div className="wrap l4-faq-grid">
          <div className="l4-faq-intro">
            <div className="l4-kicker">Good to know</div>
            <h2>Questions, <span>answered.</span></h2>
            <p>Still unsure about something? Get in touch and we&apos;ll help.</p>
            <Link className="l4-arrow" href="/contact">Contact us <span aria-hidden="true">→</span></Link>
          </div>
          <div className="l4-faq-list">
            <details open><summary>Is it really interest-free?<span aria-hidden="true">+</span></summary><p>Yes. Your bill is split into 3 equal payments and no interest is ever added. Pay each instalment on time and you repay exactly your bill amount, with no fees either. If a payment fails and stays unpaid, a capped default fee applies, as set out in our Terms.</p></details>
            <details><summary>How does my allowance work?<span aria-hidden="true">+</span></summary><p>Once you&apos;re approved, you get an interest-free healthcare allowance — a spending limit you can use at any betternow practice. Bills get split into 3 equal payments against your allowance, and your available balance reflects what you&apos;ve repaid.</p></details>
            <details><summary>Is there a credit check?<span aria-hidden="true">+</span></summary><p>Yes — a quick credit and affordability check when you sign up, done once, to set your allowance responsibly. It takes about 1 minute online, so you never take on more than you can manage.</p></details>
            <details><summary>What do I need to use betternow?<span aria-hidden="true">+</span></summary><p>You&apos;ll need to be 18 or older with a good credit record. On the practical side: a debit or credit card (Visa or Mastercard) for us to charge instalments to, your ID for a quick verification, and about 1 minute to complete the credit and affordability check.</p></details>
            <details><summary>When are instalments collected?<span aria-hidden="true">+</span></summary><p>Automatically charged to your saved card on the salary dates you choose. Pay early any time, free of charge.</p></details>
            <details><summary>Is my information safe?<span aria-hidden="true">+</span></summary><p>Your data is encrypted end-to-end and processed over secure, audited rails, and handled in line with POPIA. We never sell your information.</p></details>
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────────────── */}
      <section className="l4-final">
        <div className="wrap l4-final-grid">
          <div>
            <div className="l4-kicker l4-kicker-light">Need healthcare now?</div>
            <h2>Full recovery. <em>Zero interest.</em></h2>
          </div>
          <div>
            <p>The best bill of health is one you can actually afford.</p>
            <Link className="l4-btn l4-btn-white" href="/signup">Check my allowance <span aria-hidden="true">↗</span></Link>
          </div>
        </div>
      </section>

      <SiteFooter />

    </div>
  );
}
