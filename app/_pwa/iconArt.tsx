// ─── Shared icon art ─────────────────────────────────────────────────────
//
// The visual recipe for every PWA icon size + the apple-touch-icon.
// Composing the same component everywhere keeps the brand consistent
// (a monogram "B" on the navy→teal gradient) without committing PNGs
// to the repo — each icon route renders this JSX into a PNG via
// Next's ImageResponse pipeline.
//
// Two layouts:
//   • "any"      — the standard PWA / favicon / apple-touch-icon icon.
//                  The monogram fills ~70% of the canvas, sits on a
//                  rounded-square gradient.
//   • "maskable" — Android adaptive icons: the OS crops the canvas
//                  into a circle / squircle / teardrop. We need the
//                  important content to live inside the central 80%
//                  "safe zone" so cropping doesn't lop the mark. The
//                  gradient extends to the full canvas, the monogram
//                  is scaled down.

import type { CSSProperties } from 'react';

type Props = {
  /** Pixel size of the canvas; controls font sizing. */
  size:     number;
  /** "maskable" pulls the monogram into the safe zone. */
  variant?: 'any' | 'maskable';
};

const NAVY = '#13294B';
const TEAL = '#15A89E';

export default function IconArt({ size, variant = 'any' }: Props) {
  // Font size scales with canvas — the monogram is ~58% of canvas for
  // "any" and ~46% for "maskable" so the letter survives a circular
  // crop on Android with breathing room.
  const fontSize = Math.round(size * (variant === 'maskable' ? 0.46 : 0.58));

  // For "any", we round the corners (24% of canvas). For "maskable",
  // the OS handles the corner shape — we just fill the canvas edge to
  // edge, otherwise the rounded corners would create transparent
  // gutters that the OS would crop into.
  const borderRadius = variant === 'maskable' ? 0 : Math.round(size * 0.22);

  const style: CSSProperties = {
    width:           '100%',
    height:          '100%',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    background:      `linear-gradient(135deg, ${NAVY} 0%, ${TEAL} 140%)`,
    borderRadius:    `${borderRadius}px`,
    color:           '#FFFFFF',
    fontFamily:      'Poppins, system-ui, sans-serif',
    fontSize:        `${fontSize}px`,
    fontWeight:      700,
    letterSpacing:   '-0.04em',
    // Tiny dark drop-shadow to lift the monogram against the gradient.
    textShadow:      '0 2px 8px rgba(15, 31, 58, 0.25)',
    lineHeight:      1,
  };

  return (
    <div style={style}>
      <span style={{ transform: 'translateY(-3%)' }}>B</span>
    </div>
  );
}
