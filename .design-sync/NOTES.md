# design-sync notes — betternow Design System

Project: **betternow Design System** — https://claude.ai/design/p/e99ea6af-efeb-4800-b037-b06fbb385f1c
Shape: **package** (synth-entry — this repo has no built `dist/`).

## What this repo actually is

`hnpl` is a **Next.js application**, not a packaged component library. There is no `dist/`, no package `exports`, no Storybook. The sync is therefore a **curated presentational subset** of the app, wired by hand:

- **Entry**: `.design-sync/entry.tsx` — a barrel that re-exports exactly the 23 curated components (7 widgets + 16 marketing icons). This IS the export list (synth-entry). To add/remove a component, edit this barrel AND `cfg.componentSrcMap`.
- **`componentSrcMap`** pins each component to its real source file under `app/` (props + JSDoc come from there).

## Key setup (how the build is made to work)

- **`next/link` / `next/navigation` / `next/image` are shimmed** to plain-anchor / no-op modules (`.design-sync/shims/`) via `cfg.tsconfig` = `.design-sync/tsconfig.dssync.json`, whose `compilerOptions.paths` alias those specifiers. esbuild's tsconfig-paths plugin resolves them. This is what lets `SiteHeader`/`SiteFooter`/`StatCard`/etc. bundle + render outside Next. Any NEW curated component that imports other `next/*` subpaths needs a matching shim + paths entry.
- **CSS is generated, not shipped.** The app uses Tailwind v4 (`@import "tailwindcss"`), whose utilities are produced at build time. `cfg.cssEntry` = `.design-sync/ds.css`, compiled by the Tailwind CLI from `.design-sync/ds-input.css` (which imports `app/globals.css` + `app/landing.css` and `@source "../app"`). **Regenerate it whenever app styles/classes change** (see Re-sync).
- **Poppins is the brand display font** (`.lp-root`, loaded via `next/font` in the app → not shippable). The real Poppins woff2 (400/500/600/700, latin) were fetched from Google Fonts into `.design-sync/fonts/` and wired via `cfg.extraFonts`. Resolves the `[FONT_MISSING]` warning. Poppins is SIL OFL — redistribution is fine.
- **Guidelines disabled** (`cfg.guidelinesGlob: []`). The default glob (`docs/*.md`) matched only **internal engineering docs** (`peach-integration-audit.md`, `PASSKEYS_TESTING.md`) — NOT design guidance, and potentially sensitive. They were briefly uploaded then reconciled away. Keep guidelines off unless real design-guideline markdown is added.

## Wrapping rule (also in conventions.md)

`SiteHeader` / `SiteFooter` MUST render inside `<div className="lp-root">` — that scope carries the navy/teal tokens + Poppins. All other widgets + icons are plain Tailwind and need no wrapper. Previews reflect this.

## Build / re-sync

Regenerate CSS, then run the driver:

```sh
# 1. regenerate the Tailwind CSS (only if app styles/classes changed)
node .design-sync/.cache/tw/node_modules/@tailwindcss/cli/dist/index.mjs \
  -i .design-sync/ds-input.css -o .design-sync/ds.css
# 2. driver: build → diff → validate → capture
node .ds-sync/resync.mjs --config .design-sync/config.json \
  --node-modules ./node_modules --entry ./.design-sync/entry.tsx \
  --out ./ds-bundle --remote .design-sync/.cache/remote-sync.json
```

Playwright + Chromium are installed under `.ds-sync/` for the render check.

## Known render warns

None outstanding — 23/23 render cleanly; no `[RENDER_THIN]`/`variantsIdentical` on the authored previews.

## Re-sync risks (what can silently go stale)

- **`.design-sync/ds.css` is a generated snapshot.** If the app adds new Tailwind classes/tokens (or changes `globals.css`/`landing.css`), the committed `ds.css` won't contain them until regenerated (step 1 above). Symptom: previews using new utilities render unstyled. `@tailwindcss/cli` lives in the gitignored `.design-sync/.cache/tw` — a fresh clone must reinstall it (`npm i @tailwindcss/cli@4` there) before regenerating.
- **`@tailwindcss/cli` version pin.** Compiled with tailwindcss v4.3.3; a major Tailwind bump in the app could change output — regenerate + eyeball.
- **Components are app-coupled.** Adding more of the app's ~118 client components will usually drag in Supabase / server actions / more `next/*` — each needs shim coverage or exclusion. The 23 chosen are the ones that are genuinely self-contained. Don't assume a new one "just works" — build + render-check it.
- **`next/*` shims are lossy by design.** `<Link>` renders as `<a>` (no client routing), navigation hooks are no-ops. Fine for static preview render; never represents runtime behaviour.
- **Grades are tied to the app source + previews.** Editing a curated component in `app/` invalidates that component's grade on the next sync (correct — re-verify it).
- **Poppins is a fetched asset.** The woff2 are committed under `.design-sync/fonts/`, so re-sync is self-contained; if regenerating from scratch on a machine without network, the fetch step (see git history / the css2 URL) would fail.
