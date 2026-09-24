# Marketing images

## `public/marketing/device-approved.png`

The phone in the landing page's **How it works** section: the "You're approved!"
moment, R8,000 interest-free healthcare allowance, in the current patient-app
style.

It is **generated, not drawn**. The real patient layout (`app/patient/layout.tsx`:
bottom nav, Poppins scope) and the real `PatientScreen` shell, bell and brand
tokens are bundled unmodified; `ApprovedCelebration.tsx` in this folder is the
celebration content on top. The app has no such screen yet; the component is
written so it can be moved into `app/patient` when one is built.

### Regenerate

```sh
pnpm marketing:device-approved            # writes public/marketing/device-approved.png
pnpm marketing:device-approved --verify   # captures twice; fails if > 0.1% of pixels differ
pnpm marketing:device-approved --out /tmp/preview.png
```

Needs a Chromium for `playwright-core`: run `pnpm exec playwright-core install chromium`
once, or point `CHROMIUM_PATH` (or `PLAYWRIGHT_BROWSERS_PATH`) at an existing one.
No database, no network, no env vars: all data comes from `fixtures.ts`.

Keep the output at the same path. The deploy ID in the image URL busts the
`next/image` cache, so no code change is needed to ship a new version.

### When to regenerate

- The patient shell changes: `PatientScreen`, `PatientBottomNav`, the bell,
  `app/globals.css` tokens or the Poppins scope.
- The copy or the allowance in the image should change (`fixtures.ts`,
  `ApprovedCelebration.tsx`).
- The "You're approved" screen lands in the app for real. At that point, capture
  that screen instead and delete `ApprovedCelebration.tsx` here.

After regenerating, run `pnpm vitest run scripts/marketing` and look at the
image on the landing page over the mint orbit.

### How it works

| File | Role |
|---|---|
| `capture-device-approved.ts` | The command. Renders, screenshots at 392×832 @3x, frames, writes. Fails if the headline figure is not in Poppins or any "Pay in 2" copy renders. |
| `render.ts` | esbuild bundle of `render-entry.tsx`, Tailwind build of `app/globals.css`, the HTML page. Pins the clock during render. |
| `stubs/` | Fixture-backed stand-ins for Supabase, auth, server actions and `next/navigation`/`next/link`. Nothing else is stubbed. |
| `frame.ts` | Draws the bezel with sharp (1260×2580, 42px bezel, 160px outer radius) and composites the screenshot. Corners are exactly transparent, so no grey box shows over the page. Lossless PNG. |
| `fixtures.ts` | All data. Fictional: first name only, `@example.com`, card 4242. |
| `device-approved.test.ts` | Size and aspect, transparent corners, no Pay-in-2 copy, fixture arithmetic, no PII, harness is outside `app/`, landing wiring. |

Poppins comes from `.design-sync/fonts/` (SIL OFL), read-only.
