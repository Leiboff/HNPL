// ─── Render the celebration screen to static HTML + CSS ──────────────────
//
// esbuild bundles render-entry.tsx with the REAL app components (the patient
// layout, PatientScreen, bottom nav, bell). Only the data/auth/navigation
// modules are swapped for fixture stubs — the same trick .design-sync uses
// for next/*. Shared by the capture script and the vitest suite.
import { build, type Plugin } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURE } from './fixtures';

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, '../..');
const STUBS = path.join(HERE, 'stubs');

/** Import specifier → stub file. Everything not listed is the real module. */
const STUB_MAP: Array<[RegExp, string]> = [
  [/^@\/lib\/supabase\/server$/,                               'data.ts'],
  [/^@\/lib\/auth\/(requestUser|requireConfirmedUser|logout)$/, 'data.ts'],
  [/^\.\/logout$/,                                             'data.ts'],
  [/^@\/lib\/patient\/(requestProfile|freeze)$/,               'data.ts'],
  [/^@\/lib\/legal\/termsGate$/,                               'data.ts'],
  [/^@\/lib\/onboarding\/state$/,                              'data.ts'],
  [/^\.\/(actions|passkey-actions)$/,                          'data.ts'],
  [/^next\/navigation$/,                                       'next-navigation.ts'],
  [/^next\/link$/,                                             'next-link.tsx'],
  [/^server-only$/,                                            'empty.ts'],
];

const stubs: Plugin = {
  name: 'marketing-stubs',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      for (const [re, file] of STUB_MAP) {
        if (re.test(args.path)) return { path: path.join(STUBS, file) };
      }
      return undefined;
    });
  },
};

/** Run `fn` with Date frozen at the fixture clock, then restore it. */
async function withPinnedClock<T>(fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const pinned = RealDate.parse(FIXTURE.clock);
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length === 0) super(pinned);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static now() { return pinned; }
  }
  globalThis.Date = PinnedDate as DateConstructor;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}

/** The celebration screen inside the real patient layout, as static markup. */
export async function renderScreenMarkup(): Promise<string> {
  const outdir = await mkdtemp(path.join(tmpdir(), 'bn-marketing-'));
  const outfile = path.join(outdir, 'render.mjs');
  await build({
    entryPoints: [path.join(HERE, 'render-entry.tsx')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    tsconfig: path.join(REPO, 'tsconfig.json'),
    plugins: [stubs],
    define: { 'process.env.NODE_ENV': '"production"' },
    // CJS deps inside the ESM bundle still call require() for node builtins.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: 'error',
  });
  const mod = (await import(pathToFileURL(outfile).href)) as { renderMarkup: () => Promise<string> };
  return withPinnedClock(() => mod.renderMarkup());
}

/** Tailwind v4 build of the app's globals, scanning app/ and this folder. */
export async function buildCss(): Promise<string> {
  const from = path.join(HERE, 'tailwind-input.css');
  const result = await postcss([tailwind()]).process(await readFile(from, 'utf8'), { from });
  return result.css;
}

/** Mock status bar drawn over the app's 58px status-bar clearance. */
const STATUS_BAR = `<div id="statusbar" aria-hidden="true" style="position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 30px 0 32px;color:#fff;font:600 16px Poppins;z-index:9999;pointer-events:none"><span>09:41</span><svg width="26" height="13" viewBox="0 0 26 13" fill="none"><rect x=".75" y=".75" width="22" height="11.5" rx="3.2" stroke="#fff" stroke-opacity=".55" stroke-width="1.5"/><rect x="3" y="3" width="17.5" height="7" rx="1.6" fill="#fff"/><rect x="24" y="4.2" width="1.6" height="4.6" rx=".8" fill="#fff" fill-opacity=".55"/></svg></div>`;

/**
 * A complete HTML document, written to a temp dir with its CSS beside it.
 * The <html>/<body> classes and --font-poppins mirror app/layout.tsx, which
 * next/font would otherwise supply. Poppins comes from .design-sync/fonts
 * (the same OFL woff2 files the design-sync bundle ships).
 */
export async function writeScreenDocument(): Promise<string> {
  const [markup, css] = await Promise.all([renderScreenMarkup(), buildCss()]);
  const dir = await mkdtemp(path.join(tmpdir(), 'bn-marketing-page-'));
  await writeFile(path.join(dir, 'app.css'), css);
  const fonts = pathToFileURL(path.join(REPO, '.design-sync/fonts/poppins.css')).href;
  const html = `<!doctype html><html lang="en" class="h-full antialiased" style="--font-poppins:'Poppins'"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${fonts}"><link rel="stylesheet" href="app.css">
<style>*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}</style>
</head><body class="min-h-full flex flex-col bg-[#f7fbfb]">${markup}${STATUS_BAR}</body></html>`;
  const file = path.join(dir, 'index.html');
  await writeFile(file, html);
  return file;
}
