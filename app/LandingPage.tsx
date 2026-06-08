'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import './landing.css';

const WORDS = ['Smile', 'See', 'Hear', 'Move', 'Heal', 'Feel', 'Live'];

export default function LandingPage() {
  const [tab, setTab] = useState<'patient' | 'practice'>('patient');
  const slotRef = useRef<HTMLSpanElement>(null);

  // Verb cycling animation
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;

    const clip  = slot.querySelector('.verb-clip')  as HTMLElement;
    const strut = slot.querySelector('.verb-strut') as HTMLElement;

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

    function cycle() {
      const old = clip.querySelector('.verb.current') as HTMLElement;
      i = (i + 1) % WORDS.length;
      const next = document.createElement('span');
      next.className   = 'verb enter';
      next.textContent = WORDS[i];
      clip.appendChild(next);
      void next.offsetWidth;
      requestAnimationFrame(() => {
        old.classList.remove('current');
        old.classList.add('out');
        next.classList.remove('enter');
        next.classList.add('current');
      });
      setTimeout(() => old.remove(), 700);
    }

    const id = setInterval(cycle, 2200);
    return () => clearInterval(id);
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

  // Reveal items in newly-shown tab panel
  useEffect(() => {
    const panelId = tab === 'patient' ? 'p-patient' : 'p-practice';
    document.getElementById(panelId)?.querySelectorAll('.reveal').forEach(el => el.classList.add('in'));
  }, [tab]);

  return (
    <div className="lp-root">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header>
        <div className="wrap nav">
          <Link className="brand" href="/">
            <span className="lp-b">better</span><span className="lp-n">now</span>
          </Link>
          <nav className="nav-links">
            <a href="#how">How it works</a>
            <a href="#patients">For patients</a>
            <a href="#practices">For practices</a>
            <a href="#faq">FAQ</a>
          </nav>
          <div className="nav-cta">
            <Link className="signin" href="/login">Sign in</Link>
            <Link className="btn btn-primary btn-sm" href="/signup/practice">Get started</Link>
          </div>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="stage">
        <div className="wrap hero">
          <span className="eyebrow"><span className="dot" />&nbsp;Pay later for healthcare</span>
          <h1 aria-label="Smile better, now">
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
          <p className="sub">
            Split healthcare bills into interest-free instalments. Patients get the care they need
            today&nbsp;— practices get paid upfront.
          </p>
          <div className="ctas">
            <Link className="btn btn-primary btn-lg" href="/signup/practice">Get started as a practice</Link>
            <Link className="btn btn-ghost btn-lg"   href="/signup/patient">I&apos;m a patient</Link>
          </div>
          <div className="microtrust">
            <span><PlusIcon />Always interest-free</span>
            <span><PlusIcon />No paperwork</span>
            <span><PlusIcon />Proudly SA-built</span>
          </div>
        </div>
      </div>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section id="how">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="kicker">How it works</div>
            <h2>One flow. Two happy sides.</h2>
            <p>The same simple plan works whether you&apos;re getting care or providing it. Pick your view.</p>
          </div>
          <div className="toggle-wrap reveal">
            <div className="toggle" role="tablist" aria-label="Choose your view">
              <button
                role="tab"
                aria-selected={tab === 'patient'}
                aria-controls="p-patient"
                id="t-patient"
                onClick={() => setTab('patient')}
              >
                For patients
              </button>
              <button
                role="tab"
                aria-selected={tab === 'practice'}
                aria-controls="p-practice"
                id="t-practice"
                onClick={() => setTab('practice')}
              >
                For practices
              </button>
            </div>
          </div>

          {/* Patient panel */}
          <div className="panel" id="p-patient" role="tabpanel" aria-labelledby="t-patient" hidden={tab !== 'patient'}>
            <div className="steps">
              <div className="step reveal">
                <div className="num">STEP 1</div>
                <div className="ic"><HeartIcon /></div>
                <h3>Get the care you need</h3>
                <p>Ask for BetterNow at the practice, or tap the payment link they send you. No waiting for payday.</p>
              </div>
              <div className="step reveal">
                <div className="num">STEP 2</div>
                <div className="ic"><CalendarIcon /></div>
                <h3>Split it, interest-free</h3>
                <p>Choose 2 or 3 instalments, timed to your salary date. The price never changes — no interest, no fees stacking up.</p>
              </div>
              <div className="step reveal">
                <div className="num">STEP 3</div>
                <div className="ic"><CheckIcon /></div>
                <h3>Pay over time</h3>
                <p>Instalments come off automatically on the dates you chose. Track everything in your portal. Done.</p>
              </div>
            </div>
            <div className="example reveal">
              <div className="lead">A R3,600 bill becomes</div>
              <div className="split">
                <div className="chip"><div className="amt">R1,200</div><div className="lbl">today</div></div>
                <div className="chip"><div className="amt">R1,200</div><div className="lbl">next payday</div></div>
                <div className="chip"><div className="amt">R1,200</div><div className="lbl">payday after</div></div>
              </div>
              <div className="note">Illustrative example. Interest-free — you pay R3,600 in total, never a cent more.</div>
            </div>
          </div>

          {/* Practice panel */}
          <div className="panel" id="p-practice" role="tabpanel" aria-labelledby="t-practice" hidden={tab !== 'practice'}>
            <div className="steps">
              <div className="step reveal">
                <div className="num">STEP 1</div>
                <div className="ic"><PencilIcon /></div>
                <h3>Record the bill</h3>
                <p>Capture the patient&apos;s shortfall in seconds. No portals to log into, no forms to file, no chasing.</p>
              </div>
              <div className="step reveal">
                <div className="num">STEP 2</div>
                <div className="ic"><ClockIcon /></div>
                <h3>Patient pays over time</h3>
                <p>They split into 2–3 interest-free instalments around their salary date — approved in minutes.</p>
              </div>
              <div className="step reveal">
                <div className="num">STEP 3</div>
                <div className="ic"><CashIcon /></div>
                <h3>Get paid upfront</h3>
                <p>Receive ~94% within days. We collect the remaining instalments and carry the risk — so your cash flow doesn&apos;t.</p>
              </div>
            </div>
            <div className="example reveal">
              <div className="lead">On a R3,600 shortfall, you receive</div>
              <div className="split">
                <div className="chip"><div className="amt">~R3,384</div><div className="lbl">upfront, in days</div></div>
                <div className="chip"><div className="amt">R0</div><div className="lbl">collection risk</div></div>
                <div className="chip"><div className="amt">0 min</div><div className="lbl">admin chasing</div></div>
              </div>
              <div className="note">Illustrative example. We handle collection of all instalments after you&apos;ve been paid.</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── For patients ─────────────────────────────────────────────────── */}
      <section id="patients" className="band">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="split-head"><span className="tag pat">For patients</span></div>
            <h2>Care shouldn&apos;t wait for payday.</h2>
            <p>Get treated now and spread the cost over instalments you can actually plan around — with zero interest.</p>
          </div>
          <div className="lp-grid">
            <div className="feature reveal"><div className="ic"><EcgIcon /></div><h4>Always interest-free</h4><p>The amount you see is the amount you pay. No interest, no surprise fees, no growing balance.</p></div>
            <div className="feature reveal"><div className="ic"><CalendarIcon /></div><h4>Timed to your salary</h4><p>Instalments land on the dates that suit your pay cycle, so repayments never blindside you.</p></div>
            <div className="feature reveal"><div className="ic"><BoltIcon /></div><h4>Approved in minutes</h4><p>A quick check at the practice or on your link. No stacks of documents, no week-long wait.</p></div>
            <div className="feature reveal"><div className="ic"><ShieldIcon /></div><h4>Your data, protected</h4><p>Your information is encrypted and handled with care — never sold, never shared without cause.</p></div>
            <div className="feature reveal"><div className="ic"><CardIcon /></div><h4>One simple portal</h4><p>See every instalment, date and balance in one place. Pay early any time, free of charge.</p></div>
            <div className="feature reveal"><div className="ic"><ChatIcon /></div><h4>Real support</h4><p>Friendly, local help when you need it. We&apos;re here to keep your care on track, not trip you up.</p></div>
          </div>
          <div className="sec-cta reveal">
            <Link className="btn btn-primary btn-lg" href="/signup/patient">Get care now, pay later</Link>
          </div>
        </div>
      </section>

      {/* ── For practices ────────────────────────────────────────────────── */}
      <section id="practices">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="split-head"><span className="tag pro">For practices</span></div>
            <h2>Get paid upfront. Carry zero risk.</h2>
            <p>Turn unaffordable shortfalls into treatments that go ahead — without adding a cent of credit risk or admin to your day.</p>
          </div>
          <div className="lp-grid">
            <div className="feature reveal"><div className="ic"><CashIcon /></div><h4>~94% within days</h4><p>Stop waiting 30–90 days for shortfalls. The bulk of the bill hits your account almost immediately.</p></div>
            <div className="feature reveal"><div className="ic"><ShieldCheckIcon /></div><h4>We carry the risk</h4><p>Once you&apos;re paid, collection is on us. If a patient misses a payment, that&apos;s our problem — not yours.</p></div>
            <div className="feature reveal"><div className="ic"><PeopleIcon /></div><h4>More patients say yes</h4><p>When cost stops being the barrier, more recommended treatments actually go ahead. Better care, fuller books.</p></div>
            <div className="feature reveal"><div className="ic"><DocCheckIcon /></div><h4>Zero paperwork</h4><p>Record a bill in seconds. No portals to manage, no statements to reconcile, no debtors to chase.</p></div>
            <div className="feature reveal"><div className="ic"><BrushIcon /></div><h4>Onboard in a day</h4><p>No hardware, no integration headache. Get set up and start offering instalments to patients fast.</p></div>
            <div className="feature reveal"><div className="ic"><LayersIcon /></div><h4>Built for SA practices</h4><p>Made for South African billing, salary cycles and patients — by a team that understands the shortfall problem.</p></div>
          </div>
          <div className="sec-cta reveal">
            <Link className="btn btn-primary btn-lg" href="/signup/practice">Offer BetterNow at your practice</Link>
          </div>
        </div>
      </section>

      {/* ── Trust ────────────────────────────────────────────────────────── */}
      <section className="band trustsec">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="kicker">Why you can trust it</div>
            <h2>Built for South Africa, built on trust.</h2>
          </div>
          <div className="pillars">
            <div className="pillar reveal"><div className="ic"><EcgIcon size={26} /></div><h4>Genuinely interest-free</h4><p>Instalments, not a loan that snowballs. The total never grows beyond the original bill.</p></div>
            <div className="pillar reveal"><div className="ic"><ShieldIcon size={26} /></div><h4>Bank-grade security</h4><p>Payments and personal data are encrypted end-to-end and processed over secure, audited rails.</p></div>
            <div className="pillar reveal"><div className="ic"><DocIcon size={26} /></div><h4>Clear, upfront terms</h4><p>Every instalment, date and amount is spelled out before you agree. No hidden clauses, no fine-print traps.</p></div>
            <div className="pillar reveal"><div className="ic"><PopiaIcon size={26} /></div><h4>POPIA-conscious</h4><p>Your information is collected lawfully, kept secure, and never sold. Privacy is the default, not an add-on.</p></div>
          </div>
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────────────────────── */}
      <section id="faq">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="kicker">Questions</div>
            <h2>Good to know</h2>
          </div>
          <div className="faq">
            <details className="q reveal"><summary>Is it really interest-free?<span className="pm" /></summary><div className="a">Yes. You repay exactly the amount of your bill, split across 2 or 3 instalments. There&apos;s no interest added to the plan.</div></details>
            <details className="q reveal"><summary>How are repayments collected?<span className="pm" /></summary><div className="a">Instalments are collected automatically on the dates you choose, around your salary cycle. You can also pay early at any time, free of charge.</div></details>
            <details className="q reveal"><summary>What does it cost my practice?<span className="pm" /></summary><div className="a">Practices receive the large majority of the bill upfront, with a small fee retained for carrying collection and risk. Get in touch and we&apos;ll walk you through the exact terms for your practice.</div></details>
            <details className="q reveal"><summary>How fast do practices get paid?<span className="pm" /></summary><div className="a">Typically within a few days of recording the bill — not the weeks or months shortfalls usually take to recover.</div></details>
            <details className="q reveal"><summary>Which practices can offer BetterNow?<span className="pm" /></summary><div className="a">We&apos;re built for South African healthcare providers dealing with patient shortfalls — dental, optometry, audiology, physio, GP and specialist practices, and more. Reach out and we&apos;ll get you set up.</div></details>
            <details className="q reveal"><summary>Is my information safe?<span className="pm" /></summary><div className="a">Your data is encrypted, processed over secure rails, and handled in line with POPIA. We never sell your information.</div></details>
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────────────── */}
      <section>
        <div className="wrap">
          <div className="final reveal">
            <h2>Healthcare you can afford. Now.</h2>
            <p>Whether you&apos;re getting care or giving it, BetterNow makes the money part simple, fair and interest-free.</p>
            <div className="ctas">
              <Link className="btn btn-primary btn-lg" href="/signup/practice">Get started as a practice</Link>
              <Link className="btn btn-ghost btn-lg"   href="/signup/patient">I&apos;m a patient</Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer>
        <div className="wrap">
          <div className="foot">
            <div className="col lead">
              <span className="brand"><span className="lp-b">better</span><span className="lp-n">now</span></span>
              <p>Interest-free payment plans for healthcare. Care now, pay later — proudly built in South Africa.</p>
            </div>
            <div className="col">
              <h5>Product</h5>
              <a href="#how">How it works</a>
              <a href="#patients">For patients</a>
              <a href="#practices">For practices</a>
              <a href="#faq">FAQ</a>
            </div>
            <div className="col">
              <h5>Get started</h5>
              <Link href="/signup/practice">For practices</Link>
              <Link href="/signup/patient">For patients</Link>
              <Link href="/login">Sign in</Link>
            </div>
            <div className="col">
              <h5>Legal</h5>
              <a href="#">Terms &amp; Conditions</a>
              <a href="#">Privacy Policy</a>
              <a href="#">PAIA Manual</a>
            </div>
          </div>
          <div className="copy">
            <span>BetterNow &copy; 2026</span>
            <span>Made in South Africa</span>
          </div>
        </div>
      </footer>

    </div>
  );
}

// ── Inline SVG icons ──────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg className="plus" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function HeartIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z" /></svg>;
}

function CalendarIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>;
}

function CheckIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>;
}

function PencilIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
}

function ClockIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
}

function CashIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2" /><circle cx="12" cy="12" r="3" /><path d="M6 9v.01M18 15v.01" /></svg>;
}

function EcgIcon({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M3 12h4l2 6 4-12 2 6h6" /></svg>;
}

function BoltIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7z" /></svg>;
}

function ShieldIcon({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>;
}

function CardIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></svg>;
}

function ChatIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
}

function ShieldCheckIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>;
}

function PeopleIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></svg>;
}

function DocCheckIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z" /><path d="m9 14 2 2 4-4" /></svg>;
}

function BrushIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 16.5 3 22l5.5-1.5M14 6l4 4M6.5 13.5 13 7l4 4-6.5 6.5z" /><path d="M15 5s2-2 4-1 1 4 1 4" /></svg>;
}

function LayersIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 2 7l10 5 10-5z" /><path d="m2 17 10 5 10-5M2 12l10 5 10-5" /></svg>;
}

function DocIcon({ size = 26 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z" /></svg>;
}

function PopiaIcon({ size = 26 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 4 5v6c0 5 3.5 8.5 8 11 4.5-2.5 8-6 8-11V5z" /><path d="m9 12 2 2 4-4" /></svg>;
}
