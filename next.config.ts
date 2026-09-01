import type { NextConfig } from "next";

// ─── Security headers ───────────────────────────────────────────────────
//
// THE DEFECT (audit 2026-09-01, F-11): there were none. No CSP, no HSTS,
// no frame-ancestors, no Referrer-Policy, no nosniff. next.config.ts was
// four lines and vercel.json carried only cron entries.
//
// Two of these are doing more work here than they usually would.
//
// Referrer-Policy is load-bearing for the checkout return trip. That URL
// carries ?checkoutId=… — the value F-07 was about — and with no policy
// set the browser sends the full URL as Referer to every cross-origin
// resource the page touches. strict-origin-when-cross-origin sends the
// origin alone off-site.
//
// CSP matters more than usual because of the session cookie. @supabase/ssr
// writes it with httpOnly:false and a 400-day maxAge (see the reasoning in
// lib/auth/sessionCap.ts), so an XSS here steals a REFRESH token, not a
// one-hour access token. The absolute session cap bounds that to hours for
// traffic through the app; CSP is the layer that stops the payload landing
// at all.
//
// ─── Why the CSP is Report-Only ────────────────────────────────────────
//
// Three third parties inject script into these pages — the Peach Checkout
// V2 widget, Google Maps/Places, and Didit — and none of their exact
// origin sets is verified here. Shipping an enforcing policy on a guess
// would break card capture and identity verification in production, which
// is a worse outcome than the XSS it is guarding against and a much more
// likely one.
//
// TO ENFORCE IT: run Report-Only in production for a week, collect the
// violations, fold the real origins into the directives below, then move
// the value to the `Content-Security-Policy` key. The 'unsafe-inline' in
// script-src is a placeholder for Next's inline bootstrap and hydration
// payload; removing it needs the nonce plumbing, which is a separate
// change and should not hold up the other six headers.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  // Peach's widget and Google's maps/places loader are script-injected.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.peachpayments.com https://maps.googleapis.com https://*.didit.me",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // Google map tiles and Peach's card-brand art are remote; data: covers
  // the QR codes this app renders itself.
  "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.peachpayments.com",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.peachpayments.com https://maps.googleapis.com https://*.didit.me",
  // The Peach widget and Didit's flow both render in an iframe.
  "frame-src 'self' https://*.peachpayments.com https://*.didit.me",
  // Nobody frames us. Same intent as X-Frame-Options, in the modern form.
  "frame-ancestors 'none'",
  "base-uri 'self'",
  // No <form action> may post off-origin — a defence against an injected
  // form exfiltrating a card or an ID number.
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy-Report-Only', value: CSP_REPORT_ONLY },
  // Two years, subdomains included, preload-eligible. This app is
  // HTTPS-only on Vercel already; the header is what stops the first
  // request of a session being downgradeable.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  // Belt and braces with frame-ancestors above, for anything that still
  // only understands the older header.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // The camera IS used — Didit's liveness capture and the QR scanner at
  // /patient/scan — and geolocation is used by the practice map, so both
  // are allowed on our own origin rather than denied outright. Everything
  // else this app has no business asking for.
  {
    key: 'Permissions-Policy',
    value: [
      'camera=(self)',
      'geolocation=(self)',
      'microphone=()',
      'payment=()',
      'usb=()',
      'magnetometer=()',
      'accelerometer=()',
      'gyroscope=()',
      'interest-cohort=()',
    ].join(', '),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Every route, including the API surface and the PWA assets.
        source: '/:path*',
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
