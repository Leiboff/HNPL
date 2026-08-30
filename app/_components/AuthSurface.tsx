import type { ReactNode } from 'react';

// ─── The shared auth surface ───────────────────────────────────────────
//
// One ground for /signup, /login and /signup/patient: deep brand navy
// with soft teal light behind it and three organic shapes. Extracted
// because the gradient string was pasted into three files and had
// already started to be the kind of thing someone tweaks in one place
// and forgets in the other two.
//
// Server-safe on purpose — pure markup, no hooks — so the server-
// rendered /signup/patient can wrap itself in it without becoming a
// client component.
//
// Every colour comes from the .auth-surface token block in
// app/globals.css, which is drawn entirely from the brand palette in
// app/landing.css. Nothing here invents a hue: the ground is
// --navy-deep → --navy, the light on it is brand teal at alpha, and the
// blue depth is plain white at alpha, which over navy simply reads as a
// lighter navy and so cannot drift out of family.

const NAVY_GROUND =
  'linear-gradient(180deg, var(--auth-ground-from) 0%, var(--auth-ground-to) 100%)';

const NAVY_LIT = [
  'radial-gradient(58% 44% at 86% 2%, rgba(21,168,158,.30), transparent 70%)',
  'radial-gradient(52% 44% at 2% 92%, rgba(255,255,255,.10), transparent 72%)',
  NAVY_GROUND,
].join(', ');

type Props = {
  children: ReactNode;
  /**
   * Vertically centre the column. True for the short screens (/signup);
   * false where the content is tall enough to scroll on a small phone
   * (/login, /signup/patient), because centring a scrolling column just
   * pushes its first line off the top.
   */
  centred?: boolean;
};

export default function AuthSurface({ children, centred = false }: Props) {
  return (
    <div
      className={`auth-surface relative flex min-h-screen flex-col overflow-hidden px-5 py-12 ${
        centred ? 'justify-center' : ''
      }`}
      style={{
        background: NAVY_GROUND,
        backgroundImage: NAVY_LIT,
        fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif',
      }}
    >
      <BrandBlobs />
      <div className="relative mx-auto w-full max-w-[420px]">{children}</div>
    </div>
  );
}

/**
 * The organic background shapes. Purely decorative — blurred, aria-hidden
 * and pointer-events-none, so they can never intercept a tap on the
 * controls above them.
 */
function BrandBlobs() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Top-left: white at alpha over the navy ground — a lighter navy,
          with no hue of its own to drift. */}
      <div
        className="absolute -left-28 -top-32 h-[330px] w-[350px] blur-[34px]"
        style={{
          background: 'linear-gradient(150deg, rgba(255,255,255,.16) 0%, rgba(255,255,255,.05) 100%)',
          borderRadius: '58% 42% 47% 53% / 46% 51% 49% 54%',
        }}
      />
      {/* Right: the brand accent, largest of the three. */}
      <div
        className="absolute -right-32 top-16 h-[380px] w-[380px] blur-[30px]"
        style={{
          background: 'linear-gradient(200deg, rgba(25,194,182,.50) 0%, rgba(21,168,158,.30) 100%)',
          borderRadius: '43% 57% 62% 38% / 54% 43% 57% 46%',
        }}
      />
      {/* Bottom-left: brand teal fading into the ground, to lift the
          base of the column. */}
      <div
        className="absolute -bottom-32 -left-24 h-[340px] w-[400px] blur-[40px]"
        style={{
          background: 'linear-gradient(20deg, rgba(21,168,158,.42) 0%, rgba(255,255,255,.06) 100%)',
          borderRadius: '52% 48% 38% 62% / 44% 57% 43% 56%',
        }}
      />
    </div>
  );
}
