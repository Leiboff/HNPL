import { ImageResponse } from 'next/og';
import IconArt from '@/app/_pwa/iconArt';

// 512×512 PNG icon. Used by Android for high-density installs + the
// PWA splash screen. See app/icon-192.png/route.tsx for the rationale
// on using a manual route over Next's auto-icon convention.

export const dynamic     = 'force-static';
export const contentType = 'image/png';

export async function GET() {
  return new ImageResponse(<IconArt size={512} />, { width: 512, height: 512 });
}
