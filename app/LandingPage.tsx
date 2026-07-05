'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import './landing.css';

const WORDS = ['Smile', 'See', 'Hear', 'Move', 'Heal', 'Feel', 'Live'];

export default function LandingPage() {
  const slotRef = useRef<HTMLSpanElement>(null);

  // Verb cycling animation
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;

    const clip  = slot.querySelector('.verb-clip')  as HTMLElement;
    const strut = slot.querySelector('.verb-strut') as HTMLElement;

    // Reset clip to a single clean verb (guards against Strict Mode double-invoke
    // leaving stale elements from the first run)
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
      // Remove any lingering 'out' verbs — guards against background-tab RAF suspension
      clip.querySelectorAll<HTMLElement>('.verb.out').forEach(el => el.remove());

      const old = clip.querySelector('.verb.current') as HTMLElement | null;
      i = (i + 1) % WORDS.length;
      const next = document.createElement('span');
      next.className   = 'verb enter';
      next.textContent = WORDS[i];
      clip.appendChild(next);
      void next.offsetWidth; // flush layout so enter styles are committed
      // Switch classes synchronously — no RAF needed after forced layout
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

      {/* ── Header — DO NOT EDIT ──────────────────────────────────────────── */}
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
          </div>
        </div>
      </header>

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
            <Link className="btn btn-primary btn-lg" href="/signup/patient">I&apos;m a patient</Link>
            <Link className="btn btn-ghost btn-lg"   href="/signup/practice">I run a practice</Link>
          </div>
        </div>
      </div>

      {/* Anchor for "How it works" nav link — scrolls to the patient section */}
      <div id="how" aria-hidden="true" />

      {/* ── For patients ─────────────────────────────────────────────────── */}
      <section id="patients" className="band">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="split-head"><span className="tag pat">For patients</span></div>
            <h2>Health can&apos;t wait. Payments can.</h2>
            <p>Get treated now and spread the cost over interest-free instalments, timed to your salary dates.</p>
          </div>

          <div className="steps">
            <div className="step reveal">
              <div className="num">STEP 1</div>
              <div className="ic"><HeartIcon /></div>
              <h3>Get treated today</h3>
              <p>Ask for betternow at your practice, or tap the payment link they send you. No waiting for payday.</p>
            </div>
            <div className="step reveal">
              <div className="num">STEP 2</div>
              <div className="ic"><CalendarIcon /></div>
              <h3>Choose Pay in 2 or Pay in 3</h3>
              <p>Split your bill into 2 or 3 equal, interest-free instalments timed to your salary dates. Pay the first today, the rest by debit order on your next paydays.</p>
            </div>
            <div className="step reveal">
              <div className="num">STEP 3</div>
              <div className="ic"><CheckIcon /></div>
              <h3>Pay over your paydays</h3>
              <p>Each instalment comes off automatically by debit order on the date you chose. The price never changes — you pay your bill, never a cent more. Pay early any time, free.</p>
            </div>
          </div>

          <div className="example reveal">
            <div className="lead">Take your bill in smaller doses.</div>
            <div className="split">
              <div className="chip"><div className="amt">R1,200</div><div className="lbl">today</div></div>
              <div className="chip"><div className="amt">R1,200</div><div className="lbl">next payday</div></div>
              <div className="chip"><div className="amt">R1,200</div><div className="lbl">payday after</div></div>
            </div>
            <div className="note">A R3,600 bill, split into 3. Interest-free. You pay R3,600 in total — never more.</div>
          </div>

          <div className="lp-grid" style={{ marginTop: '42px' }}>
            <div className="feature reveal"><div className="ic"><EcgIcon /></div><h4>Always interest-free</h4><p>The amount you see is the amount you pay. No interest, no surprise fees, no growing balance.</p></div>
            <div className="feature reveal"><div className="ic"><ShieldCheckIcon /></div><h4>Give your health some credit — it&apos;s due.</h4><p>A once-off check gives you an approved, interest-free healthcare allowance to use at any betternow practice.</p></div>
            <div className="feature reveal"><div className="ic"><CalendarIcon /></div><h4>Timed to your salary</h4><p>Instalments land on the dates that suit your pay cycle, so repayments never blindside you.</p></div>
            <div className="feature reveal"><div className="ic"><LayersIcon /></div><h4>One simple portal</h4><p>See every instalment, date and balance in one place. Pay early any time, free of charge.</p></div>
            <div className="feature reveal"><div className="ic"><BoltIcon /></div><h4>Approved online, in minutes</h4><p>A quick online check — minutes, not weeks. No branch visits, no paperwork mountain.</p></div>
            <div className="feature reveal"><div className="ic"><ShieldIcon /></div><h4>Your data, protected</h4><p>Your information is encrypted and handled with care — never sold, never shared without cause.</p></div>
          </div>

          <div className="sec-cta reveal">
            <Link className="btn btn-primary btn-lg" href="/signup/patient">Give yourself a new bill of health.</Link>
          </div>
        </div>
      </section>

      {/* ── All you need ─────────────────────────────────────────────────── */}
      <section>
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="kicker">Getting started</div>
            <h2>All you need to get started</h2>
          </div>
          <div className="reqs">
            <div className="pillar reveal">
              <div className="ic"><CashIcon /></div>
              <h4>A South African bank account</h4>
              <p>Instalments come off by debit order on the salary dates you choose. No new loan, no card required.</p>
            </div>
            <div className="pillar reveal">
              <div className="ic"><ClockIcon /></div>
              <h4>A couple of minutes</h4>
              <p>Sign up, have your ID handy for a quick verification, and complete an affordability check — all online.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── For practices (navy band) ─────────────────────────────────────── */}
      <section id="practices" className="practice-band">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="split-head"><span className="tag pro">For practices</span></div>
            <h2>Turn shortfalls into treatments that go ahead.</h2>
            <p>Get paid upfront and add zero risk or admin to your day — by letting patients spread their shortfall, interest-free.</p>
          </div>

          <div className="steps">
            <div className="step reveal">
              <div className="num">STEP 1</div>
              <div className="ic"><PencilIcon /></div>
              <h3>Record the bill</h3>
              <p>Capture the patient&apos;s shortfall in seconds. No portals to log into, no forms to file, no debtors to chase.</p>
            </div>
            <div className="step reveal">
              <div className="num">STEP 2</div>
              <div className="ic"><ClockIcon /></div>
              <h3>Patient pays in 2 or 3</h3>
              <p>They split it into interest-free instalments by debit order, timed to their salary dates. No lengthy approvals.</p>
            </div>
            <div className="step reveal">
              <div className="num">STEP 3</div>
              <div className="ic"><CashIcon /></div>
              <h3>Get paid upfront</h3>
              <p>Get paid within days — we keep a small percentage as our fee and handle everything else. We collect every instalment and run the whole process, so chasing payment is never your job again.</p>
            </div>
          </div>

          <div className="example reveal">
            <div className="lead">On a R3,600 shortfall</div>
            <div className="split">
              <div className="chip"><div className="amt">Days</div><div className="lbl">to get paid</div></div>
              <div className="chip"><div className="amt">R0</div><div className="lbl">to chase</div></div>
              <div className="chip"><div className="amt">0 min</div><div className="lbl">admin</div></div>
            </div>
            <div className="note">You receive the bill amount less a small fee. We collect all instalments after you&apos;ve been paid — collection is on us.</div>
          </div>

          <div className="lp-grid" style={{ marginTop: '42px' }}>
            <div className="feature reveal"><div className="ic"><CashIcon /></div><h4>Paid upfront</h4><p>Stop waiting 30–90 days for shortfalls. The bulk of the bill hits your account within days.</p></div>
            <div className="feature reveal"><div className="ic"><ShieldCheckIcon /></div><h4>Collection is on us</h4><p>Once you&apos;re paid, the entire collection process is ours. If a patient misses a payment, chasing it is our job — not yours.</p></div>
            <div className="feature reveal"><div className="ic"><PeopleIcon /></div><h4>More patients say yes</h4><p>When cost stops being the barrier, more recommended treatments go ahead. Better care, fuller books.</p></div>
            <div className="feature reveal"><div className="ic"><DocCheckIcon /></div><h4>Zero paperwork</h4><p>Record a bill in seconds. No portals to manage, no statements to reconcile, no debtors to chase.</p></div>
            <div className="feature reveal"><div className="ic"><BrushIcon /></div><h4>Onboard in 30 seconds</h4><p>No hardware, no integration headache. Set up and start offering instalments to patients fast.</p></div>
            <div className="feature reveal"><div className="ic"><LayersIcon /></div><h4>Built for SA practices</h4><p>Made for South African billing, salary cycles and patients.</p></div>
          </div>

          <div className="sec-cta reveal">
            <Link className="btn btn-primary btn-lg" href="/signup/practice">Offer betternow at your practice</Link>
          </div>
        </div>
      </section>

      {/* ── Who it's for ─────────────────────────────────────────────────── */}
      <section className="band">
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

      {/* ── Trust ────────────────────────────────────────────────────────── */}
      <section>
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="kicker">Why you can trust it</div>
            <h2>Built on trust.</h2>
            <p>The best bill of health is one you can actually afford.</p>
          </div>
          <div className="pillars">
            <div className="pillar reveal"><div className="ic"><EcgIcon size={26} /></div><h4>Genuinely interest-free</h4><p>Instalments, not a loan that snowballs. The total never grows beyond your original bill.</p></div>
            <div className="pillar reveal"><div className="ic"><DocCheckIcon /></div><h4>Checked for affordability</h4><p>We run a quick affordability check at signup so you never take on more than you can manage.</p></div>
            <div className="pillar reveal"><div className="ic"><ShieldIcon size={26} /></div><h4>Bank-grade security</h4><p>Payments and personal data are encrypted end-to-end and processed over secure, audited rails.</p></div>
            <div className="pillar reveal"><div className="ic"><PopiaIcon size={26} /></div><h4>POPIA-conscious</h4><p>Your information is collected lawfully, kept secure, and never sold.</p></div>
          </div>
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────────────────────── */}
      <section id="faq" className="band">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="kicker">Questions</div>
            <h2>Good to know</h2>
          </div>
          <div className="faq">
            <details className="q reveal"><summary>Is it really interest-free?<span className="pm" /></summary><div className="a">Yes. You repay exactly your bill amount, split into 2 or 3 instalments. No interest, no fees added to your plan.</div></details>
            <details className="q reveal"><summary>How does my allowance work?<span className="pm" /></summary><div className="a">Once you&apos;re approved, you get an interest-free healthcare allowance — a spending limit you can use at any betternow practice. Bills get split into 2 or 3 instalments against your allowance, and your available balance reflects what you&apos;ve repaid.</div></details>
            <details className="q reveal"><summary>Is there a credit check?<span className="pm" /></summary><div className="a">Yes — a quick credit and affordability check when you sign up, done once, to set your allowance responsibly. It takes a couple of minutes online.</div></details>
            <details className="q reveal"><summary>What do I need to use betternow?<span className="pm" /></summary><div className="a">A South African bank account (so we can collect instalments by debit order), your ID for a quick verification, and a couple of minutes to complete the credit and affordability check.</div></details>
            <details className="q reveal"><summary>When are instalments collected?<span className="pm" /></summary><div className="a">Automatically, by DebiCheck debit order on the salary dates you choose. Pay early any time, free of charge.</div></details>
            <details className="q reveal"><summary>What does it cost my practice?<span className="pm" /></summary><div className="a">You receive the bill upfront, less a small percentage we keep as our fee for running collection and carrying the process. The exact fee depends on your practice — get in touch and we&apos;ll walk you through your terms.</div></details>
            <details className="q reveal"><summary>Is my information safe?<span className="pm" /></summary><div className="a">Your data is encrypted, processed over secure rails, and handled in line with POPIA. We never sell your information.</div></details>
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────────────── */}
      <section>
        <div className="wrap">
          <div className="final reveal">
            <h2>Full recovery. Zero interest.</h2>
            <p>Split any healthcare bill into interest-free instalments, timed to your salary dates.</p>
            <div className="ctas">
              <Link className="btn btn-primary btn-lg" href="/signup/patient">I&apos;m a patient</Link>
              <Link className="btn btn-ghost btn-lg"   href="/signup/practice">I run a practice</Link>
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
            <span>betternow &copy; 2026</span>
            <span>Made in South Africa</span>
          </div>
        </div>
      </footer>

    </div>
  );
}

// ── Inline SVG icons ──────────────────────────────────────────────────────────

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

function PopiaIcon({ size = 26 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 4 5v6c0 5 3.5 8.5 8 11 4.5-2.5 8-6 8-11V5z" /><path d="m9 12 2 2 4-4" /></svg>;
}
