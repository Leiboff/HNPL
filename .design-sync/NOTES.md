# design-sync notes — betternow Design System

Project: **betternow Design System** — https://claude.ai/design/p/e99ea6af-efeb-4800-b037-b06fbb385f1c
Shape: **package** (synth-entry — this repo has no built `dist/`).

## What this repo actually is

`hnpl` is a **Next.js application**, not a packaged component library. There is no `dist/`, no package `exports`, no Storybook. The sync is therefore a **curated presentational subset** of the app, wired by hand:

- **Entry**: `.design-sync/entry.tsx` — a barrel that re-exports exactly the 23 curated components (7 widgets + 16 marketing icons). This IS the export list (synth-entry). To add/remove a component, edit this barrel AND `cfg.componentSrcMap`.
- **`componentSrcMap`** pins each component to its real source file under `app/` (props + JSDoc come from there).

## Key setup (how the build is made to work)

- **`next/link` / `next/navigation` / `next/image` are shimmed** to plain-anchor / no-op modules (`.design-sync/shims/`) via `cfg.tsconfig` = `.design-sync/tsconfig.dssync.json`, whose `compilerOptions.paths` alias those specifiers. esbuild's tsconfig-paths plugin resolves them. This is what lets `SiteHeader`/`SiteFooter`/`StatCard`/etc. bundle + render outside Next. Any NEW curated component that imports other `next/*` subpaths needs a matching shim + paths entry.
- **CSS is generated, not shipped or committed.** The app uses Tailwind v4 (`@import "tailwindcss"`), whose utilities are produced at build time. `cfg.cssEntry` = `.design-sync/ds.css`, compiled by the Tailwind CLI from `.design-sync/ds-input.css` (which imports `app/globals.css` + `app/landing.css` and `@source "../app"`). **Generate it before every re-sync** (see Re-sync).
- **Poppins is the brand display font** (`.lp-root`, loaded via `next/font` in the app → not shippable). The real Poppins woff2 (400/500/600/700, latin) were fetched from Google Fonts into `.design-sync/fonts/` and wired via `cfg.extraFonts`. Resolves the `[FONT_MISSING]` warning. Poppins is SIL OFL — redistribution is fine.
- **Guidelines disabled** (`cfg.guidelinesGlob: []`). The default glob (`docs/*.md`) matched only **internal engineering docs** (`peach-integration-audit.md`, `PASSKEYS_TESTING.md`) — NOT design guidance, and potentially sensitive. They were briefly uploaded then reconciled away. Keep guidelines off unless real design-guideline markdown is added.

## Wrapping rule (also in conventions.md)

`SiteHeader` / `SiteFooter` MUST render inside `<div className="lp-root">` — that scope carries the navy/teal tokens + Poppins. All other widgets + icons are plain Tailwind and need no wrapper. Previews reflect this.

## Build / re-sync

Regenerate CSS, then run the driver:

```sh
# 1. generate the ignored Tailwind build artifact
pnpm run design-sync:css
# 2. driver: build → diff → validate → capture
node .ds-sync/resync.mjs --config .design-sync/config.json \
  --node-modules ./node_modules --entry ./.design-sync/entry.tsx \
  --out ./ds-bundle --remote .design-sync/.cache/remote-sync.json
```

Playwright + Chromium are installed under `.ds-sync/` for the render check.

## Known render warns

None outstanding — 23/23 render cleanly; no `[RENDER_THIN]`/`variantsIdentical` on the authored previews.

## Re-sync risks (what can silently go stale)

- **`.design-sync/ds.css` is an ignored build artifact.** Generate it in step 1 before invoking the sync driver. The package script bootstraps the CLI through `pnpm dlx`, so it also works on a fresh clone.
- **`@tailwindcss/cli` version pin.** The package script pins the generator to v4.3.0, matching the Tailwind packages currently resolved for the app. Keep these aligned; a Tailwind bump could change output — regenerate + eyeball.
- **Components are app-coupled.** Adding more of the app's ~118 client components will usually drag in Supabase / server actions / more `next/*` — each needs shim coverage or exclusion. The 23 chosen are the ones that are genuinely self-contained. Don't assume a new one "just works" — build + render-check it.
- **`next/*` shims are lossy by design.** `<Link>` renders as `<a>` (no client routing), navigation hooks are no-ops. Fine for static preview render; never represents runtime behaviour.
- **Grades are tied to the app source + previews.** Editing a curated component in `app/` invalidates that component's grade on the next sync (correct — re-verify it).
- **Poppins is a fetched asset.** The woff2 are committed under `.design-sync/fonts/`, so re-sync is self-contained; if regenerating from scratch on a machine without network, the fetch step (see git history / the css2 URL) would fail.
