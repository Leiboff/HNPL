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
  // Force light rendering of UA-owned chrome (form controls, scrollbars,
  // the canvas colour used before hydration). Paired with :root {
  // color-scheme: light } in globals.css and an explicit body background.
  colorScheme: "light",
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
      style={{ colorScheme: 'light' }}
    >
      <head>
        {/* Belt-and-braces: some UAs (older iOS Safari) honour the meta
            tag but ignore the CSS declaration until after the first
            paint. Declaring both ensures the canvas is light BEFORE
            hydration on every browser we care about. */}
        <meta name="color-scheme" content="light" />
      </head>
      <body className="min-h-full flex flex-col bg-[#f7fbfb]">
        {children}
        {/* Service-worker registration is a no-op when the runtime
            doesn't support it (older browsers); see SwRegister for
            the install + activate flow + cache-busting on deploy. */}
        <SwRegister />
      </body>
    </html>
  );
}
