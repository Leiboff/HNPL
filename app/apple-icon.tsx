import { ImageResponse } from 'next/og';
import IconArt from './_pwa/iconArt';

// ─── Apple touch icon ────────────────────────────────────────────────────
//
// Next auto-emits <link rel="apple-touch-icon" href=…> from this file.
// 180×180 is the size iOS uses for the home-screen icon — iOS does NOT
// read the manifest's icon entries; it reads this meta tag. Without
// this, "Add to Home Screen" on iOS gets a screenshot of the page
// instead of our brand monogram. The most common iOS PWA bug.
//
// iOS also ignores the manifest's theme_color for the status bar — we
// override that via the apple-mobile-web-app-status-bar-style meta
// declared in app/layout.tsx.

export const size        = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(<IconArt size={180} />, size);
}
