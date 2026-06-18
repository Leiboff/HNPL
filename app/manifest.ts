import type { MetadataRoute } from 'next';

// ─── Web App Manifest ────────────────────────────────────────────────────
//
// File-based metadata route picked up automatically by Next 16 — emitted
// at /manifest.webmanifest with the correct content-type, and a
// <link rel="manifest"> auto-injected into the document head.
//
// Brand tokens
//   • Theme colour:      #13294B (navy) — drives the OS status-bar tint
//     when the app is opened standalone. Navy reads as trustworthy /
//     medical-adjacent and matches our wordmark colour token, which is
//     what we want at the moment the patient first sees the app frame.
//   • Background colour: #FAFBFD (page surface) — the splash background
//     before React mounts. Matches the page surface used across all
//     surfaces (set via the visual-pass commit). Anything else would
//     flash a wrong colour on cold launch.
//
// Why standalone + portrait
//   This is a phone-first app a patient uses one-handed. We never want
//   the browser chrome shown when launched from the home screen
//   (standalone) and the form layouts assume portrait — landscape on a
//   phone is a worse experience.
//
// Icons reference Next's auto-generated icon routes (app/icon*.tsx +
// app/apple-icon.tsx). Each route renders a PNG via ImageResponse, so
// there is no static binary in the repo — the icons are generated at
// request time, content-hashed, and cached by Vercel's CDN.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name:             'BetterNow — pay later for healthcare',
    short_name:       'BetterNow',
    description:
      'Split healthcare bills into interest-free instalments. Patients get care today — practices get paid upfront.',
    start_url:        '/patient',
    scope:            '/',
    display:          'standalone',
    orientation:      'portrait',
    theme_color:      '#13294B',
    background_color: '#FAFBFD',
    categories:       ['health', 'finance', 'medical'],
    lang:             'en-ZA',
    dir:              'ltr',
    icons: [
      // 192 — Android home screen + manifest minimum
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      // 512 — Android splash + high-DPI installs
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Maskable variant — Android adaptive icons. Same 512 canvas but
      // with safe-zone padding so the OS can crop it into any shape
      // without lopping our wordmark.
      { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
