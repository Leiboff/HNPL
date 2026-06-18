import { ImageResponse } from 'next/og';
import IconArt from '@/app/_pwa/iconArt';

// 512×512 PNG maskable icon for Android adaptive icons. The OS crops
// the icon into whatever shape the launcher uses (circle, squircle,
// teardrop), so the wordmark must sit inside the safe inner 80% of
// the canvas. IconArt's "maskable" variant handles that.

export const dynamic     = 'force-static';
export const contentType = 'image/png';

export async function GET() {
  return new ImageResponse(
    <IconArt size={512} variant="maskable" />,
    { width: 512, height: 512 },
  );
}
