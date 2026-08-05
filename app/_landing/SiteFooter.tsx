import Link from 'next/link';
import { PopiaIcon } from './icons';

// ─── SiteFooter — shared marketing footer ──────────────────────────────
//
// Same on both landing pages. "For practices" now routes to the
// dedicated /practices page rather than a landing anchor.

export default function SiteFooter() {
  return (
    <footer>
      <div className="wrap">
        <div className="foot">
          <div className="col lead">
            <span className="brand"><span className="lp-b">better</span><span className="lp-n">now</span></span>
            <p>Interest-free payment plans for healthcare. Care now, pay later — proudly built in South Africa.</p>
          </div>
          <div className="col">
            <h5>Product</h5>
            <Link href="/#why">Why betternow</Link>
            <Link href="/#how">How it works</Link>
            <Link href="/practices">For practices</Link>
            <Link href="/#faq">FAQ</Link>
          </div>
          <div className="col">
            <h5>Get started</h5>
            <Link href="/signup/patient">For patients</Link>
            <Link href="/signup/practice">For practices</Link>
            <Link href="/login">Sign in</Link>
          </div>
          <div className="col">
            <h5>Legal</h5>
            <Link href="/legal/terms">Terms &amp; Conditions</Link>
            <Link href="/legal/privacy">Privacy Policy</Link>
            <a href="#">PAIA Manual</a>
          </div>
        </div>
        <div className="copy">
          <span>betternow &copy; 2026</span>
          <span className="foot-popia"><PopiaIcon /> Made in South Africa</span>
        </div>
      </div>
    </footer>
  );
}
