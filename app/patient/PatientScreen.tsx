// ─── PatientScreen — the v4 navy-shell layout ────────────────────────────
//
// Every logged-in patient surface is the same shape: a navy header that
// runs to the top edge, carrying a teal glow, with a light sheet lifting
// over it (rounded top corners, pulled up 14px). Content lives on the
// sheet; the global bottom nav (patient layout) floats below.
//
// Tones:
//   navy  — the default brand canvas (#0B1F3A)
//   fail  — the missed-payment state (#7A1F1F), red glow, used once
//
// The header content varies per screen (balance hero, a title, a back
// row, a profile row) so it comes in as `header`. Presentational only —
// a plain server component.
//
// Width: mobile is the full-bleed phone column (max-w-md). On desktop the
// shell widens to a comfortable, CENTRED column that scales with the
// viewport and caps at max-w-5xl (1024px) — so content beside the sidebar
// uses the space instead of reading as a stretched phone, while ultra-wide
// screens stay capped (centred, symmetric margins — never a dead right-side
// void). Every patient screen flows through here, so the width is uniform.

const CANVAS = {
  navy: { bg: '#0B1F3A', glow: 'radial-gradient(72% 88% at 96% -8%, rgba(21,168,158,.34), transparent 62%)' },
  fail: { bg: '#7A1F1F', glow: 'radial-gradient(72% 88% at 96% -8%, rgba(255,107,90,.40), transparent 62%)' },
} as const;

export default function PatientScreen({
  header,
  children,
  tone = 'navy',
  /** Extra bottom padding on the sheet (screens with a fixed footer set 0). */
  sheetClassName = 'px-[18px] pt-5 pb-2',
  /** Find care overlaps a search field into the sheet — it needs -16px. */
  sheetOverlap = 14,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
  tone?: 'navy' | 'fail';
  sheetClassName?: string;
  sheetOverlap?: number;
}) {
  const canvas = CANVAS[tone];
  return (
    <div style={{ background: '#F4F7F8', minHeight: '100%' }}>
      <div className="mx-auto w-full max-w-md md:max-w-3xl lg:max-w-5xl">

        {/* Navy header — runs to the top edge, teal glow overlay. */}
        <div className="relative" style={{ background: canvas.bg }}>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: canvas.glow }}
          />
          <div className="relative px-[22px] pt-6 pb-8">{header}</div>
        </div>

        {/* Light sheet, lifted over the navy. */}
        <div
          className={`relative ${sheetClassName}`}
          style={{
            background: '#F4F7F8',
            borderRadius: '30px 30px 0 0',
            marginTop: -sheetOverlap,
          }}
        >
          {children}
        </div>

      </div>
    </div>
  );
}
