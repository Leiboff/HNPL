import Link from 'next/link';
import type { CSSProperties } from 'react';

// ─── The betternow wordmark, on the auth surface ───────────────────────
//
// The same two spans were written out in six files — /login, the two
// views of /signup, and every screen that has since joined them on the
// navy ground. Each copy carried its own size, its own tracking and its
// own decision about whether the mark linked home, which is how the
// journey ended up with a 46px mark on one screen and a 22px one on the
// next.
//
// One component, one size scale. "better" is plain white, "now" is
// --auth-accent — the ONLY place the split-colour mark is written down
// for the dark surface, so it cannot drift from screen to screen.
//
// Requires an ancestor .auth-surface for --auth-accent (see
// app/_components/authFormStyles.ts for why that coupling is deliberate).

type Size = 'lg' | 'md';

const SIZES: Record<Size, string> = {
  /** The arrival screens — /login, /signup. The mark IS the header. */
  lg: 'text-[46px]',
  /** Mid-journey screens, where a step title carries the weight instead. */
  md: 'text-[34px]',
};

type Props = {
  size?: Size;
  /**
   * Whether the mark links to the marketing home page. True on screens a
   * visitor arrives at; false mid-flow, where a link home is an exit sign
   * next to the step they are trying to finish.
   */
  href?: string | null;
  className?: string;
};

export default function AuthWordmark({ size = 'lg', href = '/', className = '' }: Props) {
  const cls = `inline-block ${SIZES[size]} font-bold leading-none tracking-[-0.04em] text-white`;
  const now: CSSProperties = { color: 'var(--auth-accent)' };

  const mark = <>better<span style={now}>now</span></>;

  return (
    <div className={`text-center ${className}`}>
      {href ? (
        <Link href={href} className={cls}>{mark}</Link>
      ) : (
        <span className={cls}>{mark}</span>
      )}
    </div>
  );
}
