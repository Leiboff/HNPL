'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

// ─── SiteHeader — sticky marketing chrome for / and /practices ──────────
//
// Reused on both marketing pages so nav + sign-in are identical. The
// header is already position: sticky in landing.css; this component
// adds:
//   • A subtle box-shadow once the page scrolls past the top (a
//     sentinel + IntersectionObserver — cheaper than a scroll
//     listener and works past passive-listener throttling).
//   • A mobile burger menu (< 900 px) that slides down under the
//     header. Same open/close discipline as SettingsSheet: Escape
//     closes, click a link auto-closes.
//
// Header links point at LANDING anchors regardless of the current
// page — "For practices" is a full route to /practices; everything
// else is a hash into /. That means clicking "How it works" on
// /practices sends the user home to the corresponding section, which
// is the intent.

export default function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);

  // Sticky-shadow: observe a tiny sentinel at the very top of the
  // page. When it leaves the viewport, we're scrolled past the top.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'position:absolute;top:0;left:0;height:1px;width:1px;pointer-events:none';
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.setAttribute('data-testid', 'site-header-scroll-sentinel');
    document.body.prepend(sentinel);

    const header = headerRef.current;
    if (!header) { sentinel.remove(); return; }
    const io = new IntersectionObserver(
      ([entry]) => header.classList.toggle('scrolled', !entry.isIntersecting),
      { threshold: 0 },
    );
    io.observe(sentinel);
    return () => { io.disconnect(); sentinel.remove(); };
  }, []);

  // Escape closes the mobile menu.
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setMenuOpen(false); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <header ref={headerRef} className="site-header">
      <div className="wrap nav">
        <Link className="brand" href="/">
          <span className="lp-b">better</span><span className="lp-n">now</span>
        </Link>

        {/* Why/How/FAQ are plain <a> tags, not next/link's <Link> — Link's
            App Router same-pathname hash navigation is a documented no-op
            when the page doesn't change (only the hash does), so clicking
            "How it works" while already on / silently failed to scroll.
            A native anchor lets the browser handle the fragment jump
            itself, which works whether you're already on / or arriving
            from another page. "For practices" is a real route change, so
            it stays a Link. */}
        <nav className="nav-links" aria-label="Primary">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberate, see comment above */}
          <a href="/#why">Why betternow</a>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberate, see comment above */}
          <a href="/#how">How it works</a>
          <Link href="/practices">For practices</Link>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberate, see comment above */}
          <a href="/#faq">FAQ</a>
        </nav>

        <div className="nav-cta">
          {/* The hero already carries the primary "Get started" CTA
              (LandingPage.tsx), so the persistent header pill is Sign
              in instead — a returning patient's most common header
              action, without duplicating the hero's own button. */}
          <Link className="nav-signin" href="/login">Sign in</Link>
          <button
            type="button"
            className="burger"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="site-mobile-menu"
            onClick={() => setMenuOpen((o) => !o)}
            data-testid="site-header-burger"
          >
            <span /><span /><span />
          </button>
        </div>
      </div>

      {menuOpen && (
        <div
          id="site-mobile-menu"
          className="mobile-menu"
          data-testid="site-header-mobile-menu"
        >
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberate, see comment above */}
          <a href="/#why"         onClick={() => setMenuOpen(false)}>Why betternow</a>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberate, see comment above */}
          <a href="/#how"         onClick={() => setMenuOpen(false)}>How it works</a>
          <Link href="/practices" onClick={() => setMenuOpen(false)}>For practices</Link>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberate, see comment above */}
          <a href="/#faq"         onClick={() => setMenuOpen(false)}>FAQ</a>
          <div className="mobile-cta">
            <Link className="m-get" href="/signup/patient" onClick={() => setMenuOpen(false)}>Get started</Link>
            <Link className="m-signin" href="/login" onClick={() => setMenuOpen(false)}>Sign in</Link>
          </div>
        </div>
      )}
    </header>
  );
}
