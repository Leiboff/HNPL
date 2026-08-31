// ─── InstalmentLadder — the v4 signature schedule graphic ────────────────
//
// One segment per instalment, laid out as an equal-width flex row. It is
// the single recurring visual object across the patient portal: it appears
// on the Home plan rows, both Plans lists, the Plan-detail hero, and the
// Account on-time record. Build it once, read it anywhere.
//
//   filled  = paid        ringed = next/current      hollow = to come
//   amber   = an unaccepted bill's commitment (Plans "Waiting on you")
//
// Two tones. `light` sits on the white sheet; `dark` sits on a navy hero
// (mint fills, translucent-white "to come", a wider 5px gap). Presentational
// only — a plain server component, no state, no data access.

export type LadderSegment = 'paid' | 'next' | 'coming' | 'pending';

const SEGMENT_STYLE: Record<'light' | 'dark', Record<LadderSegment, React.CSSProperties>> = {
  light: {
    paid:    { background: 'var(--portal-accent)' },
    next:    { background: 'rgba(21,168,158,.28)', boxShadow: 'inset 0 0 0 2px var(--portal-accent)' },
    coming:  { background: 'var(--portal-line)' },
    pending: { background: '#EDE0C6' },
  },
  dark: {
    paid:    { background: 'var(--brand-teal-bright)' },
    next:    { background: 'rgba(92,217,206,.3)', boxShadow: 'inset 0 0 0 2px var(--brand-teal-bright)' },
    coming:  { background: 'rgba(255,255,255,.16)' },
    // No unaccepted-bill state on navy — pending ladders only render on
    // the white sheet. Fall back to the "to come" treatment defensively.
    pending: { background: 'rgba(255,255,255,.16)' },
  },
};

export default function InstalmentLadder({
  segments,
  tone = 'light',
  className,
}: {
  segments: LadderSegment[];
  tone?: 'light' | 'dark';
  className?: string;
}) {
  if (segments.length === 0) return null;
  return (
    <div
      className={className}
      data-testid="instalment-ladder"
      style={{ display: 'flex', gap: tone === 'dark' ? 5 : 4, height: 10 }}
      aria-hidden="true"
    >
      {segments.map((state, i) => (
        <span
          key={i}
          style={{ flex: 1, borderRadius: 99, ...SEGMENT_STYLE[tone][state] }}
        />
      ))}
    </div>
  );
}

// ─── Helper: build a ladder from a paid/total pair ───────────────────────
//
// The common case — N total instalments, `paid` already collected, the
// next one due. Produces [paid… , next, coming…]. When all are paid the
// last stays `paid` (no dangling "next"). Pass `pending` to render an
// unaccepted bill's full commitment as amber segments.
export function ladderFromCounts(
  total: number,
  paid: number,
  variant: 'active' | 'pending' = 'active',
): LadderSegment[] {
  const n = Math.max(0, total);
  if (variant === 'pending') return Array.from({ length: n }, () => 'pending' as LadderSegment);
  return Array.from({ length: n }, (_, i) => {
    if (i < paid) return 'paid';
    if (i === paid) return 'next';
    return 'coming';
  });
}
