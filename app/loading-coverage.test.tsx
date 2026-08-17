import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';

// ─── Route-level loading coverage ────────────────────────────────────────
//
// Before this work: 66 server-rendered pages, ZERO loading.tsx, ZERO
// error.tsx and one Suspense boundary whose fallback was `null`. Every
// route transition left the previous screen on the display until the
// server finished, which on a mobile PWA over a SA mobile network reads as
// a broken app.
//
// This file pins two things a per-file test cannot:
//
//  1. COVERAGE — that every server-rendered page is beneath SOME
//     loading.tsx boundary. Coverage is the property that decays: the next
//     route someone adds under /practice inherits the area fallback for
//     free, but a whole new area added with no loading.tsx would silently
//     go back to the old behaviour. The walk below fails when that happens.
//
//  2. NO REGRESSION TO NOTHING — that each fallback actually renders
//     something. A `loading.tsx` exporting an empty fragment satisfies
//     Next.js and satisfies a file-exists check, while restoring exactly
//     the frozen-screen bug this work removes. So every fallback is
//     RENDERED here and asserted to produce a labelled status region with
//     real blocks in it.

const ROOT = resolve(process.cwd());
const APP  = resolve(ROOT, 'app');

/** Every page.tsx that is a SERVER component (async default export). */
function serverPages(dir = APP, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { serverPages(p, out); continue; }
    if (entry.name !== 'page.tsx') continue;
    const src = readFileSync(p, 'utf8');
    if (/^\s*export default async function/m.test(src)) out.push(p);
  }
  return out;
}

/** Every loading.tsx, as the directory it governs. */
function loadingDirs(dir = APP, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { loadingDirs(p, out); continue; }
    if (entry.name === 'loading.tsx') out.push(dir);
  }
  return out;
}

const SERVER_PAGES  = serverPages();
const LOADING_DIRS  = loadingDirs();

/**
 * Route groups — `(auth)` — are URL-transparent but ARE real directories
 * for the purposes of file-convention nesting, so a plain prefix match is
 * the correct test here.
 */
function coveredBy(pageFile: string): string | null {
  const pageDir = pageFile.slice(0, pageFile.lastIndexOf(sep));
  let best: string | null = null;
  for (const d of LOADING_DIRS) {
    if (pageDir === d || pageDir.startsWith(d + sep)) {
      if (best === null || d.length > best.length) best = d;
    }
  }
  return best;
}

const rel = (p: string) => p.slice(ROOT.length + 1).replace(/\\/g, '/');

describe('the inventory this work started from', () => {
  it('there are still many server-rendered pages (the metric is real)', () => {
    // Sanity: if this collapsed to a handful, the walk above has broken and
    // every coverage assertion below would pass vacuously.
    expect(SERVER_PAGES.length).toBeGreaterThan(50);
  });

  it('loading.tsx files now exist, where there were none', () => {
    expect(LOADING_DIRS.length).toBeGreaterThan(15);
  });
});

describe('COVERAGE — every server page sits under a loading boundary', () => {
  it('no server-rendered page is left with no fallback', () => {
    const uncovered = SERVER_PAGES.filter((p) => coveredBy(p) === null).map(rel);
    // Listed by name so a failure says exactly which route regressed
    // rather than just a count.
    expect(uncovered).toEqual([]);
  });

  it.each(
    // The routes the Step 0 investigation identified as the slowest by
    // SERIAL round-trip depth — the ones where a missing fallback is felt.
    [
      ['checkout/[token]',          16],
      ['practice',                   9],
      ['practice/settings',          9],
      ['admin/practices/[id]',       9],
      ['brand',                      8],
      ['brand/revenue',              8],
      ['crm/leads/[id]',             8],
      ['practice/bills',             7],
      ['practice/payouts',           7],
      ['practice/bills/new',         7],
      ['admin/customers/[patientId]', 7],
    ] as const,
  )('%s (%i serial awaits) is covered', (route, _serialAwaits) => {
    const page = resolve(APP, route, 'page.tsx');
    expect(existsSync(page), `${route}/page.tsx exists`).toBe(true);
    expect(coveredBy(page), `${route} has a loading boundary`).not.toBeNull();
  });

  it('the deepest applicable boundary wins, so leaf shapes are not shadowed', () => {
    // /practice/bills must resolve to its OWN list-shaped fallback, not to
    // the dashboard-shaped one at /practice.
    const bills = resolve(APP, 'practice/bills', 'page.tsx');
    expect(rel(coveredBy(bills)!)).toBe('app/practice/bills');

    const practice = resolve(APP, 'practice', 'page.tsx');
    expect(rel(coveredBy(practice)!)).toBe('app/practice');
  });
});

describe('NO REGRESSION TO NOTHING — every fallback renders real content', () => {
  // Each loading.tsx is imported and rendered. They are server components
  // wrapping a client DelayedSkeleton; rendering the module's default gives
  // the DelayedSkeleton with its server-rendered children as props, so what
  // we assert on is the children — which is the content that matters here.
  const modules = LOADING_DIRS.map((d) => ({
    dir:  rel(d),
    file: join(d, 'loading.tsx'),
  }));

  it('there is one to check for every boundary found', () => {
    expect(modules.length).toBe(LOADING_DIRS.length);
    expect(modules.length).toBeGreaterThan(15);
  });

  it.each(modules.map((m) => [m.dir, m.file] as const))(
    '%s renders a labelled status region with blocks',
    async (dir, file) => {
      const mod = await import(/* @vite-ignore */ file);
      expect(typeof mod.default, `${dir} exports a default`).toBe('function');

      // Render the skeleton tree directly. DelayedSkeleton's delay is a
      // client-side concern tested in components/loading/Skeleton.test.tsx;
      // here we want the CONTENT, so we render the children it was given.
      const el = mod.default();
      const children = el?.props?.children;
      expect(children, `${dir} passes children to DelayedSkeleton`).toBeTruthy();

      const { container } = render(children);
      try {
        // An empty fragment would satisfy Next.js and a file-exists check
        // while restoring the frozen-screen bug. This is the assertion that
        // catches it.
        expect(container.innerHTML.length, `${dir} renders markup`).toBeGreaterThan(50);

        const region = screen.getByRole('status');
        expect(region.textContent, `${dir} announces what is loading`).toMatch(/\S/);
        expect(region).toHaveAttribute('aria-busy', 'true');

        const animated = container.querySelectorAll('[class*="animate-"]');
        expect(animated.length, `${dir} has skeleton blocks`).toBeGreaterThan(0);
        for (const a of animated) {
          expect(a.className, `${dir}: ${a.className}`).toMatch(/motion-(safe|reduce):/);
        }
      } finally {
        cleanup();
      }
    },
  );
});

describe('every fallback goes through the shared primitives', () => {
  it('no loading.tsx hand-rolls its own animate- class', () => {
    // The point of one shared set is that the shimmer and the accessibility
    // treatment change in one place. A route reaching for animate-pulse
    // directly is how eight ad-hoc spinners happened the first time.
    const offenders: string[] = [];
    for (const d of LOADING_DIRS) {
      const src = readFileSync(join(d, 'loading.tsx'), 'utf8');
      // Comments legitimately discuss the classes; strip them first.
      const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/animate-pulse/.test(code)) offenders.push(rel(d));
    }
    expect(offenders).toEqual([]);
  });

  it('every loading.tsx imports DelayedSkeleton, so none can flash', () => {
    const missing: string[] = [];
    for (const d of LOADING_DIRS) {
      const src = readFileSync(join(d, 'loading.tsx'), 'utf8');
      if (!/DelayedSkeleton/.test(src)) missing.push(rel(d));
    }
    expect(missing).toEqual([]);
  });
});
