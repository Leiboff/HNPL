# design-sync notes — betternow Design System

Project: **betternow Design System** — https://claude.ai/design/p/b9bc2894-8ccf-4501-ab93-952d6a1ba51d
Shape: **package** (synth-entry — this repo has no built `dist/`).

**2026-08-22 re-sync note:** the previously-synced project (`e99ea6af-…`) had been deleted from claude.ai/design (`get_project` 404, `list_projects` empty) — this run created a fresh project with the same name and re-anchored `.design-sync/config.json`'s `projectId` to it. If the project disappears again, check whether something is deleting design-system projects before just re-running the sync.

## What this repo actually is

`hnpl` is a **Next.js application**, not a packaged component library. There is no `dist/`, no package `exports`, no Storybook. The sync is therefore a **curated presentational subset** of the app, wired by hand:

- **Entry**: `.design-sync/entry.tsx` — a barrel that re-exports exactly the 23 curated components (7 widgets + 16 marketing icons). This IS the export list (synth-entry). To add/remove a component, edit this barrel AND `cfg.componentSrcMap`.
- **`componentSrcMap`** pins each component to its real source file under `app/` (props + JSDoc come from there).

## Key setup (how the build is made to work)

- **`next/link` / `next/navigation` / `next/image` are shimmed** to plain-anchor / no-op modules (`.design-sync/shims/`) via `cfg.tsconfig` = `.design-sync/tsconfig.dssync.json`, whose `compilerOptions.paths` alias those specifiers. esbuild's tsconfig-paths plugin resolves them. This is what lets `SiteHeader`/`SiteFooter`/`StatCard`/etc. bundle + render outside Next. Any NEW curated component that imports other `next/*` subpaths needs a matching shim + paths entry.
- **CSS is generated, not shipped.** The app uses Tailwind v4 (`@import "tailwindcss"`), whose utilities are produced at build time. `cfg.cssEntry` = `.design-sync/ds.css`, compiled by the Tailwind CLI from `.design-sync/ds-input.css` (which imports `app/globals.css` + `app/landing.css` and `@source "../app"`). **Regenerate it whenever app styles/classes change** (see Re-sync).
- **Poppins is the brand display font** (`.lp-root`, loaded via `next/font` in the app → not shippable). The real Poppins woff2 (400/500/600/700, latin) were fetched from Google Fonts into `.design-sync/fonts/` and wired via `cfg.extraFonts`. Resolves the `[FONT_MISSING]` warning. Poppins is SIL OFL — redistribution is fine.
- **Guidelines disabled** (`cfg.guidelinesGlob: []`). The default glob (`docs/*.md`) matched only **internal engineering docs** (`peach-integration-audit.md`, `PASSKEYS_TESTING.md`) — NOT design guidance, and potentially sensitive. They were briefly uploaded then reconciled away. Keep guidelines off unless real design-guideline markdown is added.

## `.d.ts` extraction gap — generic `type Props` isn't found (fixed via `dtsPropsFor`)

The converter's prop extractor only picks up a type/interface named exactly `<ComponentName>Props`. All 5 curated widgets (`StatCard`, `CollectionStatusBadge`, `DefaultFreezeBanner`, `ApprovedBalanceCard`, `PendingPlanCard`) declare a local generic `type Props = {...}` instead — this repo's house style — so extraction silently fell back to `[key: string]: unknown` with **no build warning**. That would have shipped the design agent a contentless prop contract for the components it's most likely to actually configure (tone, bucket, frozen, limit/available, planId, etc.).

Fixed by hand-writing `cfg.dtsPropsFor` for all 5 (see config.json), verified against each component's real source type. **If a new widget is added to `componentSrcMap`, check `components/<group>/<Name>/<Name>.d.ts` in the build output for `[key: string]: unknown` before trusting it** — this repo's `type Props` convention means every new one will need a `dtsPropsFor` entry too, since the extractor doesn't warn.

## `SiteHeader` viewport override (`cfg.overrides.SiteHeader.viewport`)

`SiteHeader`'s desktop nav (`Why betternow` / `How it works` / `For practices` / `FAQ`) only shows via `@media(min-width: 1080px)` (`landing.css`); below that it's the hamburger-only mobile state. The capture/render-check default viewport is 900×700, so the primary card silently rendered mobile-only — no nav links visible, no render error either. Set `viewport: "1200x120"` so the card shows the real desktop nav. **If `landing.css`'s 1080px breakpoint ever changes, re-check this override still clears it.**

## Wrapping rule (also in conventions.md)

`SiteHeader` / `SiteFooter` MUST render inside `<div className="lp-root">` — that scope carries the navy/teal tokens + Poppins. All other widgets + icons are plain Tailwind and need no wrapper. Previews reflect this.

## Build / re-sync

Stage the scripts (gitignored, recreate per clone), regenerate CSS, then run the driver:

```sh
# 0. stage the converter + install its deps (isolated from the repo's own lockfile)
mkdir -p .ds-sync && cp -r <skill-base-dir>/{package-build.mjs,package-validate.mjs,package-capture.mjs,resync.mjs,lib,storybook} .ds-sync/
echo '{"name":"ds-sync-deps","private":true}' > .ds-sync/package.json
(cd .ds-sync && npm i esbuild ts-morph @types/react playwright)

# 1. regenerate the Tailwind CSS (only if app styles/classes changed)
mkdir -p .design-sync/.cache/tw && (cd .design-sync/.cache/tw && npm i @tailwindcss/cli@4)
node .design-sync/.cache/tw/node_modules/@tailwindcss/cli/dist/index.mjs \
  -i .design-sync/ds-input.css -o .design-sync/ds.css

# 2. fetch the project's verification anchor (skip on a project with no prior sync)
#    DesignSync(get_file, path: "_ds_sync.json") → save to .design-sync/.cache/remote-sync.json

# 3. driver: build → diff → validate → capture
DS_CHROMIUM_PATH=<path-to-a-chromium-binary> node .ds-sync/resync.mjs \
  --config .design-sync/config.json --node-modules ./node_modules \
  --entry ./.design-sync/entry.tsx --out ./ds-bundle \
  --remote .design-sync/.cache/remote-sync.json   # omit --remote on a project with no anchor yet
```

**Chromium for the render check**: this repo has no `playwright`/`@playwright/test` dependency of its own (tests use vitest + happy-dom), so `npm i playwright` under `.ds-sync/` pulls whatever's current — that version's pinned browser build will very likely NOT match a pre-installed Chromium the host environment provides (e.g. Claude Code's web/cloud sessions pre-install a specific build under `/opt/pw-browsers/chromium-<rev>/`). Don't try to version-match; both `package-validate.mjs` and `package-capture.mjs` read `process.env.DS_CHROMIUM_PATH` and launch that binary directly instead of playwright's own managed browser — always set it to the host's actual Chromium binary. Read `<installed-playwright-core>/node_modules/playwright-core/browsers.json` as a plain file (its `exports` map blocks `require()`) if you need to sanity-check what a freshly-`npm i`'d playwright expects.

## Known render warns

None outstanding — 23/23 render cleanly; no `[RENDER_THIN]`/`variantsIdentical` on the authored previews.

## Re-sync risks (what can silently go stale)

- **`.design-sync/ds.css` is a generated snapshot.** If the app adds new Tailwind classes/tokens (or changes `globals.css`/`landing.css`), the committed `ds.css` won't contain them until regenerated (step 1 above). Symptom: previews using new utilities render unstyled. `@tailwindcss/cli` lives in the gitignored `.design-sync/.cache/tw` — a fresh clone must reinstall it (`npm i @tailwindcss/cli@4` there) before regenerating.
- **`@tailwindcss/cli` version pin.** Compiled with tailwindcss v4.3.3; a major Tailwind bump in the app could change output — regenerate + eyeball.
- **Components are app-coupled.** Adding more of the app's ~118 client components will usually drag in Supabase / server actions / more `next/*` — each needs shim coverage or exclusion. The 23 chosen are the ones that are genuinely self-contained. Don't assume a new one "just works" — build + render-check it.
- **`next/*` shims are lossy by design.** `<Link>` renders as `<a>` (no client routing), navigation hooks are no-ops. Fine for static preview render; never represents runtime behaviour.
- **Grades are tied to the app source + previews.** Editing a curated component in `app/` invalidates that component's grade on the next sync (correct — re-verify it).
- **Poppins is a fetched asset.** The woff2 are committed under `.design-sync/fonts/`, so re-sync is self-contained; if regenerating from scratch on a machine without network, the fetch step (see git history / the css2 URL) would fail.
- **The project can vanish out from under the pin.** This happened once (2026-08-22) — the prior `projectId` 404'd and `list_projects` came back empty, so this run had to create a replacement project and re-point `config.json`. Grades/previews/config all carried over fine (they're local + committed), but the project's upload history and any manual edits made directly in claude.ai/design were lost with it. If it recurs, that's worth escalating rather than silently re-creating each time.
- **Local grade cache (`.design-sync/.cache/review/`) is gitignored and does not survive a fresh clone.** On a machine with no prior `.cache/` AND no reachable project anchor (new project, or the anchor fetch was skipped), every authored component must be fully re-graded from screenshots — there's no shortcut. This is expected, not a bug: verified-state durability comes from the uploaded `_ds_sync.json`, not from local files.
