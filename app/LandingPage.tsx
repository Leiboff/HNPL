'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import SiteHeader from './_landing/SiteHeader';
import SiteFooter from './_landing/SiteFooter';
import {
  CalendarIcon,
  ClockIcon,
  EcgIcon,
  BoltIcon,
  CardIcon,
} from './_landing/icons';
import './landing.css';

// ─── Landing page — patient audience only ──────────────────────────────
//
// This file is the SINGLE-AUDIENCE landing page. Provider-facing
// content lives on /practices; the header + footer link there. The
// legacy in-page #practices anchor is deliberately dropped —
// bookmarks that included it are redirected to /practices by the
// hash-redirect effect below.

const WORDS = ['Smile', 'See', 'Hear', 'Move', 'Heal', 'Feel', 'Live'];

export default function LandingPage() {
  const slotRef = useRef<HTMLSpanElement>(null);

  // Old #practices anchor → /practices. Handles bookmarks and any
  // external link that used the old fragment.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash === '#practices') {
      window.location.replace('/practices');
    }
  }, []);

  // Verb cycling animation — unchanged from the original.
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;

    const clip  = slot.querySelector('.verb-clip')  as HTMLElement;
    const strut = slot.querySelector('.verb-strut') as HTMLElement;

    clip.innerHTML = `<span class="verb current">${WORDS[0]}</span>`;

    const probe = document.createElement('span');
    const cs    = getComputedStyle(clip.querySelector('.verb.current') as Element);
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font};letter-spacing:${cs.letterSpacing}`;
    document.body.appendChild(probe);

    let max = 0;
    WORDS.forEach(w => { probe.textContent = w; max = Math.max(max, probe.offsetWidth); });
    slot.style.width  = Math.ceil(max) + 'px';
    strut.textContent = WORDS.reduce((a, b) => b.length > a.length ? b : a, WORDS[0]);
    probe.remove();

    let i = 0;
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    function cycle() {
      clip.querySelectorAll<HTMLElement>('.verb.out').forEach(el => el.remove());

      const old = clip.querySelector('.verb.current') as HTMLElement | null;
      i = (i + 1) % WORDS.length;
      const next = document.createElement('span');
      next.className   = 'verb enter';
      next.textContent = WORDS[i];
      clip.appendChild(next);
      void next.offsetWidth;
      old?.classList.remove('current');
      old?.classList.add('out');
      next.classList.remove('enter');
      next.classList.add('current');
      timeouts.push(setTimeout(() => old?.remove(), 700));
    }

    const id = setInterval(cycle, 2200);
    return () => {
      clearInterval(id);
      timeouts.forEach(clearTimeout);
    };
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
    <div className="lp-root">

      <SiteHeader />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="stage">
        <div className="wrap hero">
          <h1 aria-label="betternow">
            <span ref={slotRef} className="verb-slot" aria-hidden={true}>
              <span className="verb-strut">Smile</span>
              <span className="verb-clip">
                <span className="verb current">Smile</span>
              </span>
            </span>
            <span className="wordmark" aria-hidden={true}>
              <span className="lp-b">better</span><span className="lp-n">now</span>
            </span>
          </h1>
          <p className="tagline">
            Get better now. Pay better later.
          </p>
          <p className="sub">
            Split any healthcare bill into interest-free instalments, timed to your salary dates. Get the care you need today.
          </p>
          <div className="ctas">
            <Link className="btn btn-primary btn-lg" href="/signup/patient">Get started</Link>
            <Link className="btn btn-outline btn-lg" href="/login">Sign in</Link>
          </div>
        </div>
      </div>

      {/* ── Why betternow — exactly 3 reason cards (Payflex pattern) ───── */}
      <section id="why" className="band">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="kicker">Why betternow</div>
            <h2>Why betternow</h2>
          </div>
          <div className="lp-grid why-grid">
            <div className="feature reveal">
              <div className="ic"><CalendarIcon /></div>
              <h4>Flexible payment options</h4>
              <p>Choose Pay in 2 or Pay in 3 — interest-free instalments timed to your salary dates. Pay early any time, free.</p>
            </div>
            <div className="feature reveal">
              <div className="ic"><EcgIcon /></div>
              <h4>Always interest-free</h4>
              <p>You pay your bill, never a cent more. No interest, no fees on your plan.</p>
            </div>
            <div className="feature reveal">
              <div className="ic"><BoltIcon /></div>
              <h4>1-minute approval</h4>
              <p>Get approved online in 1 minute. No paperwork, no branch visits.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works — vertical timeline + plan-chooser card ────────── */}
      <section id="how">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="kicker">How it works</div>
            <h2>Health can&apos;t wait. Payments can.</h2>
            <p>Take your bill in smaller doses.</p>
          </div>

          <div className="how-two-col">
            <ol className="timeline reveal">
              <li className="tl-step">
                <div className="tl-num">1</div>
                <div className="tl-body">
                  <h3>Get treated today</h3>
                  <p>Ask for betternow at your practice, or tap the payment link they send you. No waiting for payday.</p>
                </div>
              </li>
              <li className="tl-step">
                <div className="tl-num">2</div>
                <div className="tl-body">
                  <h3>Choose Pay in 2 or Pay in 3</h3>
                  <p>Split your bill into 2 or 3 equal, interest-free instalments timed to your salary dates. Pay the first today, the rest charged automatically to your card on your next paydays.</p>
                </div>
              </li>
              <li className="tl-step">
                <div className="tl-num">3</div>
                <div className="tl-body">
                  <h3>Pay over your paydays</h3>
                  <p>Each instalment is charged to your saved card automatically on the date you chose. The price never changes — you pay your bill, never a cent more. Pay early any time, free.</p>
                </div>
              </li>
            </ol>

            <div className="how-visual reveal">
              <Image
                className="plan-chooser"
                src="/marketing/plan-chooser.png"
                alt="betternow payment plan options — pay in 2 or pay in 3, interest-free"
                width={1080}
                height={1218}
                priority={false}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── All you need to get started — soft-tinted band, text+CTA left,
             device-approved.png right on desktop ────────────────────────── */}
      <section className="gs-band">
        <div className="wrap">
          <div className="gs-two-col reveal">
            <div className="gs-text">
              <div className="kicker">Getting started</div>
              <h2>All you need to get started</h2>
              <p>Give your health some credit — it&apos;s due.</p>
              <div className="gs-reqs">
                <div className="pillar">
                  <div className="ic"><CardIcon /></div>
                  <h4>A debit or credit card</h4>
                  <p>Your instalments are charged automatically to your Visa or Mastercard — debit or credit.</p>
                </div>
                <div className="pillar">
                  <div className="ic"><ClockIcon /></div>
                  <h4>1 minute</h4>
                  <p>Sign up, have your ID handy, and complete a quick credit and affordability check — all online in about 1 minute. You&apos;ll need to be 18 or older with a good credit record.</p>
                </div>
              </div>
              <div className="gs-cta">
                <Link className="btn btn-primary btn-lg" href="/signup/patient">Get started</Link>
              </div>
            </div>
            <div className="gs-visual">
              <Image
                className="device"
                src="/marketing/device-approved.png"
                alt="betternow app showing an approved interest-free healthcare allowance"
                width={630}
                height={1290}
                priority={false}
              />
              <p className="illustration-note">Illustration</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── FAQ (patient-only) ──────────────────────────────────────────── */}
      <section id="faq">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="kicker">Questions</div>
            <h2>Good to know</h2>
          </div>
          <div className="faq">
            <details className="q reveal"><summary>Is it really interest-free?<span className="pm" /></summary><div className="a">Yes. You repay exactly your bill amount, split into 2 or 3 instalments. No interest, no fees added to your plan. Instalments, not a loan that snowballs — the total never grows beyond your original bill.</div></details>
            <details className="q reveal"><summary>How does my allowance work?<span className="pm" /></summary><div className="a">Once you&apos;re approved, you get an interest-free healthcare allowance — a spending limit you can use at any betternow practice. Bills get split into 2 or 3 instalments against your allowance, and your available balance reflects what you&apos;ve repaid.</div></details>
            <details className="q reveal"><summary>Is there a credit check?<span className="pm" /></summary><div className="a">Yes — a quick credit and affordability check when you sign up, done once, to set your allowance responsibly. It takes about 1 minute online, so you never take on more than you can manage.</div></details>
            <details className="q reveal"><summary>What do I need to use betternow?<span className="pm" /></summary><div className="a">You&apos;ll need to be 18 or older with a good credit record. On the practical side: a debit or credit card (Visa or Mastercard) for us to charge instalments to, your ID for a quick verification, and about 1 minute to complete the credit and affordability check.</div></details>
            <details className="q reveal"><summary>When are instalments collected?<span className="pm" /></summary><div className="a">Automatically charged to your saved card on the salary dates you choose. Pay early any time, free of charge.</div></details>
            <details className="q reveal"><summary>Is my information safe?<span className="pm" /></summary><div className="a">Your data is encrypted end-to-end and processed over secure, audited rails, and handled in line with POPIA. We never sell your information.</div></details>
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────────────── */}
      <section>
        <div className="wrap">
          <div className="final reveal">
            <h2>Full recovery. Zero interest.</h2>
            <p>The best bill of health is one you can actually afford.</p>
            <div className="ctas">
              <Link className="btn btn-primary btn-lg" href="/signup/patient">Get started</Link>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />

    </div>
  );
}
