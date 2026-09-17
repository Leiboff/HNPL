// ─── PatientScreen — the v5 patient shell ────────────────────────────────
//
// One navy crown, three heights. Every patient screen is one of them:
//
//   'navy' — the screen LEADS WITH A NUMBER. A tall --brand-navy-deep
//            block carrying a soft teal glow, with the light content
//            sheet lifting over it (rounded top corners, pulled up 18px).
//            Home (available balance) and Plan detail (amount left) — that
//            is the whole list, and it should stay that way: the HEIGHT is
//            what makes a figure read as the point of the screen.
//
//   'crown' — a BOTTOM-NAV TAB that has no figure to lead with: Plans,
//            Find care, Account. Same navy, same glow, same sheet lift —
//            but only as tall as its title needs, so it reads as chrome
//            rather than as a hero.
//
//            v5 took the band off these screens entirely, on the argument
//            that a dark slab carrying nothing but a name spends the
//            loudest object on the screen for nothing. That argument was
//            about a ~150px slab; it is not about ~110px of chrome, and
//            stripping the band had a cost the argument missed. A phone
//            shows the status bar over whatever the app paints under it,
//            so Home met the notch in navy and the other three tabs met it
//            in pale grey — the five tabs of one app opening five
//            different ways. The crown is the band earning its keep at
//            chrome height: one shell, one top edge, one app.
//
//   'plain' — SECOND-LEVEL screens: the Account sub-screens, Refer, the
//            practitioner detail. These are reached from a tab, not from
//            the nav bar, and their header is a back row — a back chevron
//            on navy would promise a hero that isn't coming. Flat
//            --portal-sheet, header on the sheet, content starts at the top.
//
//   'fail' — the missed-payment state (#7A1F1F, red glow). A 'navy'
//            screen in every respect but the colour; it leads with the
//            amount owed. Left as a literal on purpose: a semantic state
//            colour, not brand.
//
// The 58px top padding is not a spacing choice — it is the status bar.
// Both shapes carry it so the first line of content clears the notch
// identically whether or not there is a navy band behind it.
//
// Presentational only — a plain server component.
//
// Width: mobile is the full-bleed phone column (max-w-md). On desktop the
// shell widens to a comfortable, CENTRED column that scales with the
// viewport and caps at max-w-5xl (1024px) — so content beside the sidebar
// uses the space instead of reading as a stretched phone, while ultra-wide
// screens stay capped (centred, symmetric margins — never a dead right-side
// void). Every patient screen flows through here, so the width is uniform.

// The 280px glow circle is offset off the top-right corner so only its
// lower-left quadrant falls on the band — a glow arriving from off-screen
// rather than a blob centred in the corner. `pb` is the ONLY thing that
// separates a crown from a hero: same colour, same glow, same sheet lift.
const CANVAS = {
  navy:  { bg: 'var(--brand-navy-deep)', glow: 'rgba(25,194,182,.30)', size: 280, top: -90, right: -70, pb: 30 },
  crown: { bg: 'var(--brand-navy-deep)', glow: 'rgba(25,194,182,.30)', size: 280, top: -90, right: -70, pb: 26 },
  fail:  { bg: '#7A1F1F',                glow: 'rgba(255,107,90,.34)', size: 280, top: -90, right: -70, pb: 30 },
} as const;

export default function PatientScreen({
  header,
  children,
  tone = 'navy',
  /** Sheet padding. Screens with a fixed footer override the bottom. */
  sheetClassName = 'px-[18px] pt-5 pb-2',
  /** How far the sheet lifts over the navy band. Ignored when tone='plain'. */
  sheetOverlap = 18,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
  tone?: 'navy' | 'crown' | 'fail' | 'plain';
  sheetClassName?: string;
  sheetOverlap?: number;
}) {
  // ── Plain: no band. The header sits on the sheet, above the content,
  // with the status-bar clearance moved onto the page itself.
  if (tone === 'plain') {
    return (
      <div style={{ background: 'var(--portal-sheet)', minHeight: '100%' }}>
        <div className="mx-auto w-full max-w-md md:max-w-3xl lg:max-w-5xl">
          <div className="pt-[58px]">
            {/* The header block's own gutter is 20px — two more than the
                sheet's 18px — so a 27px title optically lines up with the
                card edges below it rather than with their text. */}
            <div className="px-[20px] pt-2 pb-[18px]">{header}</div>
            <div className={sheetClassName}>{children}</div>
          </div>
        </div>
      </div>
    );
  }

  const canvas = CANVAS[tone];
  return (
    <div style={{ background: 'var(--portal-sheet)', minHeight: '100%' }}>
      <div className="mx-auto w-full max-w-md md:max-w-3xl lg:max-w-5xl">

        {/* Navy header — runs to the top edge, teal glow overlay. */}
        <div className="relative overflow-hidden" style={{ background: canvas.bg }}>
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-full"
            style={{
              top: canvas.top,
              right: canvas.right,
              width: canvas.size,
              height: canvas.size,
              background: `radial-gradient(circle, ${canvas.glow}, transparent 68%)`,
            }}
          />
          <div className="relative px-[20px] pt-[58px]" style={{ paddingBottom: canvas.pb }}>{header}</div>
        </div>

        {/* Light sheet, lifted over the navy. */}
        <div
          className={`relative ${sheetClassName}`}
          style={{
            background: 'var(--portal-sheet)',
            borderRadius: '22px 22px 0 0',
            marginTop: -sheetOverlap,
          }}
        >
          {children}
        </div>

      </div>
    </div>
  );
}
