import { ImageResponse } from 'next/og';
import IconArt from './_pwa/iconArt';

// ─── Favicon ─────────────────────────────────────────────────────────────
// Auto-emitted as <link rel="icon"> by Next 16's file-based metadata
// convention. 32×32 covers desktop browser favicon use; the manifest
// references the dedicated /icon-192 + /icon-512 routes for PWA use.

export const size        = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(<IconArt size={32} />, size);
}
