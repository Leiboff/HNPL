import { ImageResponse } from 'next/og';
import IconArt from '@/app/_pwa/iconArt';

// ─── 192×192 PNG icon ────────────────────────────────────────────────────
//
// Referenced from app/manifest.ts. Static at build time so Vercel CDNs
// it indefinitely — content-hash is implicit (the route always returns
// the same bytes for a given deploy).
//
// Why a manual route instead of Next's app/icon-<n>.tsx convention:
// the manifest needs a stable URL we can hard-reference, and the
// auto-emitted convention puts a content hash in the URL. A bare path
// is the simpler contract for the manifest.

export const dynamic     = 'force-static';
export const contentType = 'image/png';

export async function GET() {
  return new ImageResponse(<IconArt size={192} />, { width: 192, height: 192 });
}
