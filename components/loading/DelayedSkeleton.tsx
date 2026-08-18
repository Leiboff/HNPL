'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { SKELETON_DELAY_MS } from './timing';

/**
 * Renders nothing for the first SKELETON_DELAY_MS, then its children.
 *
 * ─── WHY loading.tsx NEEDS THIS AT ALL ────────────────────────────────
 *
 * A Suspense fallback appears the instant navigation starts. For a
 * response that resolves in 60 ms that means a skeleton flashes and
 * vanishes, which reads as a rendering bug rather than as speed — a
 * flicker is a defect signal, where a briefly-still screen is merely
 * quick. So the fallback has to hold itself back.
 *
 * ─── WHY IT IS A CLIENT COMPONENT WRAPPING SERVER CHILDREN ────────────
 *
 * Only the client can measure elapsed time, so the gate must be
 * 'use client'. But the skeleton content should stay server-rendered:
 * it is static markup, and several routes' skeletons reuse real server
 * shells (PatientScreen, for instance) to get an exact shape match.
 *
 * Passing them as `children` gets both. A client component may receive
 * server-rendered children as props — they are rendered on the server
 * into the RSC payload, and this component only decides whether to
 * output them. Nothing in the skeleton tree is forced to become a client
 * component by being wrapped here, which is why the loading.tsx files
 * themselves can stay server components.
 *
 * ─── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────
 *
 * There is no minimum display duration, and there cannot be one: React
 * unmounts a Suspense fallback the moment the real content streams in,
 * and the fallback has no hook, callback or veto over its own removal.
 * So a response landing at 160 ms will show a skeleton for ~10 ms. That
 * is a real, accepted residue of this design; it is bounded by choosing
 * the delay against actual network latency (see ./timing.ts) rather than
 * by pretending otherwise. Where we DO own the state machine — in-place
 * actions — a minimum duration exists; see ./usePendingAction.ts.
 */
export default function DelayedSkeleton({
  children,
  delayMs = SKELETON_DELAY_MS,
}: {
  children: ReactNode;
  /** Override only with a reason; the shared value is the default for consistency. */
  delayMs?: number;
}) {
  // Starts false on both server and client, so the first client render
  // matches the server output and there is no hydration mismatch. The
  // timer is what reveals it, never the initial state.
  const [show, setShow] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);

  if (!show) return null;
  return <>{children}</>;
}
