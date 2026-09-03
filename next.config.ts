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
// CSP is generated per HTML request in proxy.ts, not here. A static header
// cannot carry an unpredictable nonce, and a nonce is what permits Next's
// own scripts without granting every inline script the same authority.

const SECURITY_HEADERS = [
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
  // ─── The drift cron reads the migrations off disk ─────────────────────
  //
  // /api/cron/rls-drift replays supabase/migrations/*.sql to work out what
  // the repo believes the RLS policy set is, then compares that against the
  // live catalog. Next traces imports; it cannot see a readdirSync, so
  // without this entry the .sql files are absent from the lambda and the
  // route fails at RUNTIME rather than at build.
  //
  // Scoped to that one route deliberately — 912KB of SQL has no business in
  // any other bundle.
  outputFileTracingIncludes: {
    '/api/cron/rls-drift': ['./supabase/migrations/**/*.sql'],
  },

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
