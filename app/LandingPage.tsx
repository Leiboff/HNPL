'use client';

import { useEffect, useRef, useState } from 'react';
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

// Relative timing labels for the bill-splitter illustration. Deliberately
// NOT real dates — the real schedule comes from the patient's chosen
// salary_day (lib/salaryDates.ts) at checkout.
const WHEN = ['Today', 'Next payday', 'The payday after'];

function randLabel(n: number): string {
  const [i, d] = n.toFixed(2).split('.');
  return 'R' + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + d;
}

export default function LandingPage() {
  const slotRef = useRef<HTMLSpanElement>(null);

  // Bill-splitter — presentational only (no fetch, no persistence). The
  // example bill is a fixed R3,000 (no slider); only the plan choice is
  // interactive. The arithmetic mirrors the FAQ: equal instalments,
  // instalment 1 absorbs the rounding remainder, total never exceeds the
  // bill.
  const bill = 3000;
  const [plan, setPlan] = useState<2 | 3>(3);

  const splitBase = Math.floor((bill / plan) * 100) / 100;
  const splitRows = Array.from({ length: plan }, (_, k) => ({
    n:      k + 1,
    when:   WHEN[k],
    amount: randLabel(k === 0 ? Math.round((bill - splitBase * (plan - 1)) * 100) / 100 : splitBase),
  }));

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
    <div className="lp-root lp-v3">

      <SiteHeader />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="stage">
        <div className="wrap hero">
          <div className="eyebrow"><BoltIcon /> 1-minute approval</div>
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
            <Link className="btn btn-primary btn-lg" href="/signup">Get started</Link>
            {/* Plain <a>, not next/link's <Link> — same-page hash
                navigation via Link is a documented App Router no-op
                (see SiteHeader.tsx), so this silently failed to scroll
                to #how while already on /. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberate, see comment above */}
            <a className="btn btn-outline btn-lg" href="/#how">See how it works</a>
          </div>
        </div>

        {/* Verb marquee — a scrolling strip of the hero verbs. Decorative;
            duplicated once for a seamless loop, whole strip aria-hidden. */}
        <div className="verb-marquee" aria-hidden={true}>
          <div className="verb-marquee-track">
            {[0, 1].map((dup) => (
              <div className="verb-marquee-row" key={dup}>
                {WORDS.map((w) => (
                  <span key={w}>
                    <span className="vm-word">{w}</span>
                    <span className="vm-dot">•</span>
                  </span>
                ))}
              </div>
            ))}
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

      {/* ── How it works — vertical timeline + live bill-splitter widget ── */}
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
              <div className="split-two-col">
                <div className="split-intro">
                  <div className="kicker">Your bill, in doses</div>
                  <p className="split-lead">A R3,000 example bill, split into equal, interest-free instalments timed to your salary dates. Pick your plan.</p>
                  <div className="split-controls">
                    <div className="split-bill">
                      <span className="split-bill-label">Your bill</span>
                      <span className="split-bill-amt">{randLabel(bill)}</span>
                    </div>
                    <div className="split-plans">
                      <button type="button" className={`split-plan${plan === 2 ? ' on' : ''}`} onClick={() => setPlan(2)}>Pay in 2</button>
                      <button type="button" className={`split-plan${plan === 3 ? ' on' : ''}`} onClick={() => setPlan(3)}>Pay in 3</button>
                    </div>
                  </div>
                </div>

                <div className="split-card">
                  <div className="split-card-top">
                    <span className="split-card-eyebrow">Your plan</span>
                    <span className="split-chip">
                      <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 10.5l3 3 7-7" /></svg>
                      Interest-free
                    </span>
                  </div>
                  <div className="split-per">
                    <span className="split-per-name">{plan === 2 ? 'Pay in 2' : 'Pay in 3'} · equal instalments</span>
                    <span className="split-per-amt">{randLabel(splitBase)}</span>
                    <span className="split-per-sub">per instalment</span>
                  </div>
                  <div className="split-rows">
                    {splitRows.map((r) => (
                      <div className="split-row" key={r.n}>
                        <span className="split-row-n">{r.n}</span>
                        <span className="split-row-when">{r.when}</span>
                        <span className="split-row-amt">{r.amount}</span>
                      </div>
                    ))}
                  </div>
                  <div className="split-totals">
                    <div className="split-total-row"><span>Total you pay</span><span>{randLabel(bill)}</span></div>
                    <div className="split-fees"><span>Interest and plan fees</span><span className="split-zero">R0.00</span></div>
                  </div>
                  <p className="split-note">Illustration only. Your allowance and instalments depend on your approved limit and chosen salary dates.</p>
                </div>
              </div>
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
            </div>
          </div>
          {/* CTA lives OUTSIDE the two-column grid so the read order is
              content → image → CTA on both mobile (stacked) and desktop
              (centered row below both columns). */}
          <div className="gs-cta reveal">
            <Link className="btn btn-primary btn-lg" href="/signup">Get started</Link>
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
              <Link className="btn btn-primary btn-lg" href="/signup">Get started</Link>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />

    </div>
  );
}
