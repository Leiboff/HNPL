import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Poppins } from "next/font/google";
import "./globals.css";
import SwRegister from "./_pwa/SwRegister";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// ─── PWA-aware metadata ─────────────────────────────────────────────────
//
// Next 16 emits the manifest <link> from app/manifest.ts automatically.
// What we still need to declare explicitly:
//   • appleWebApp           — iOS reads these meta tags, not the
//                             manifest, for "Add to Home Screen".
//                             Without `capable: true` iOS launches the
//                             home-screen icon into Safari with the
//                             address bar, not standalone.
//   • viewport.themeColor   — drives the OS status-bar tint when the
//                             app is opened standalone. Must live on
//                             `viewport`, not `metadata`, in Next 16
//                             (the field was moved in 14.x).

export const metadata: Metadata = {
  title: "betternow — pay later for healthcare",
  description:
    "Split healthcare bills into interest-free instalments. Patients get care today — practices get paid upfront.",
  applicationName: "BetterNow",
  appleWebApp: {
    capable:    true,
    title:      "BetterNow",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#13294B",
  width:      "device-width",
  initialScale: 1,
  // The browser shouldn't let the user zoom out of our standalone
  // app's layout — but we MUST allow zoom in (accessibility) so the
  // user can pinch-zoom on small text. maximumScale=5 is the safe
  // default for that.
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${poppins.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        {/* Service-worker registration is a no-op when the runtime
            doesn't support it (older browsers); see SwRegister for
            the install + activate flow + cache-busting on deploy. */}
        <SwRegister />
      </body>
    </html>
  );
}
