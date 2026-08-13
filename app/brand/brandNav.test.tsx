import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import BrandNav from './BrandNav';
import BrandShell from './BrandShell';
import { getBrandNavLinks, isBrandNavActive } from './brandNavLinks';

// ─── The brand nav ─────────────────────────────────────────────────────────
//
// /brand had no nav at all. It had one screen with two quick-action tiles, a
// settings page with a hand-written back-link, and /brand/revenue — a fully
// built by-practice / by-doctor breakdown — reachable from NOTHING. Not one href
// in the product pointed at it, and it stayed that way precisely because there
// was no shared place a link could be added to.
//
// So the tests here answer three questions:
//
//   1. Are all four tabs there, from the shared source, on every brand screen?
//   2. Is /brand/revenue now REACHABLE — the bug that started this?
//   3. Can a second, hand-written brand nav appear without failing a test?
//
// (3) is the brand-side version of the practice nav's desktop/mobile parity
// guard. Brand has ONE nav component rather than two, so there is no pair to
// compare; the invariant with teeth is that no OTHER file under app/brand
// hand-writes these hrefs, because that is how the practice side's two lists
// diverged in the first place. The guard walks the tree and asserts it.

let pathname = '/brand';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

beforeEach(() => {
  pathname = '/brand';
  cleanup();
});

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const LINKS_SRC = read('app/brand/brandNavLinks.ts');
const NAV_SRC   = read('app/brand/BrandNav.tsx');

function renderedLinks(): Array<{ href: string; label: string }> {
  return screen.getAllByRole('link').map((el) => ({
    href:  el.getAttribute('href') ?? '',
    label: el.textContent ?? '',
  }));
}

// ─── The four tabs ─────────────────────────────────────────────────────────

describe('Overview · Practices · Reports · Settings', () => {
  it('renders exactly those four, in that order', () => {
    render(<BrandNav />);
    expect(renderedLinks()).toEqual([
      { href: '/brand',           label: 'Overview'  },
      { href: '/brand/practices', label: 'Practices' },
      { href: '/brand/revenue',   label: 'Reports'   },
      { href: '/brand/group',     label: 'Settings'  },
    ]);
  });

  it('REPORTS points at /brand/revenue — the screen that had no inbound link at all', () => {
    // The bug this whole nav exists for. Asserted on the rendered href rather
    // than on the source, because a constant nobody renders is still no link.
    render(<BrandNav />);
    const reports = renderedLinks().find((l) => l.label === 'Reports');
    expect(reports).toBeTruthy();
    expect(reports!.href).toBe('/brand/revenue');
  });

  it('SETTINGS points at the page that already existed — nothing was invented', () => {
    // The brief said to add Settings only if a brand settings surface already
    // exists. /brand/group did: "Brand settings", name + logo.
    render(<BrandNav />);
    expect(renderedLinks().find((l) => l.label === 'Settings')!.href).toBe('/brand/group');
    expect(read('app/brand/group/page.tsx')).toMatch(/Brand settings/);
  });

  it('every tab is unconditional — brand membership is the only authority in play', () => {
    // Unlike the practice nav's Settings entry, which is gated. Stated as a
    // property of the source: no parameters, no conditionals.
    const code = stripComments(LINKS_SRC);
    expect(code).toMatch(/export function getBrandNavLinks\(\): BrandLink\[\]/);
    // No authority concept anywhere in the module.
    expect(code).not.toMatch(/canManage|isBrandAdmin|practice_members/);
    // And the link function itself takes no arguments and branches on nothing —
    // scoped to that function, because isBrandNavActive below it legitimately
    // branches on the path (Overview needs an exact match).
    const fn = code.slice(code.indexOf('export function getBrandNavLinks'));
    const body = fn.slice(0, fn.indexOf('}') + 1);
    expect(body).not.toMatch(/if \(|\?|&&/);
  });

  it('hands out a fresh array, so no caller can mutate the shared list', () => {
    const a = getBrandNavLinks();
    a.push({ href: '/hax', label: 'Hax' });
    a[0].label = 'Mutated';
    expect(getBrandNavLinks()).toHaveLength(4);
    expect(getBrandNavLinks()[0].label).toBe('Overview');
  });
});

// ─── Active tab ────────────────────────────────────────────────────────────

describe('the active tab', () => {
  const CASES: Array<[string, string]> = [
    ['/brand',                    'Overview'],
    ['/brand/practices',          'Practices'],
    ['/brand/revenue',            'Reports'],
    ['/brand/group',              'Settings'],
  ];

  it.each(CASES)('on %s exactly ONE tab is current, and it is %s', (path, label) => {
    pathname = path;
    render(<BrandNav />);
    const current = screen.getAllByRole('link').filter((el) => el.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toBe(label);
  });

  it('Overview needs an EXACT match — it is a prefix of every other brand route', () => {
    // A startsWith test would light Overview up on all four tabs. Same rule the
    // practice nav applies to /practice.
    expect(isBrandNavActive('/brand', '/brand')).toBe(true);
    expect(isBrandNavActive('/brand', '/brand/practices')).toBe(false);
    expect(isBrandNavActive('/brand', '/brand/revenue')).toBe(false);
    expect(isBrandNavActive('/brand', '/brand/group')).toBe(false);
  });

  it('a child route keeps its parent tab lit', () => {
    // /brand/revenue?practice=… and any future /brand/practices/[id].
    expect(isBrandNavActive('/brand/revenue', '/brand/revenue')).toBe(true);
    expect(isBrandNavActive('/brand/practices', '/brand/practices/p1')).toBe(true);
  });

  it('a route with no tab lights nothing — no accidental fallback to Overview', () => {
    pathname = '/brand/new-practice';
    render(<BrandNav />);
    expect(
      screen.getAllByRole('link').filter((el) => el.getAttribute('aria-current') === 'page'),
    ).toHaveLength(0);
  });
});

// ─── The shell carries it on every brand screen ────────────────────────────

describe('BrandShell', () => {
  it('mounts the nav, so any screen it wraps is navigable', () => {
    render(<BrandShell brandName="Bright Smiles" brandCount={1}>{<p>body</p>}</BrandShell>);
    expect(screen.getByTestId('brand-nav')).toBeTruthy();
    expect(renderedLinks()).toHaveLength(4);
  });

  it('names the brand at n=1 brands', () => {
    render(<BrandShell brandName="Bright Smiles" brandCount={1}>{null}</BrandShell>);
    expect(screen.getByTestId('brand-shell-title').textContent).toBe('Bright Smiles');
  });

  it('refuses to name ONE brand when the caller admins several', () => {
    // Naming the first would misdescribe the page: the practices below span all
    // of them.
    render(<BrandShell brandName="Bright Smiles" brandCount={3}>{null}</BrandShell>);
    expect(screen.getByTestId('brand-shell-title').textContent).toBe('My brands');
  });

  it('falls back to a neutral title rather than rendering an empty heading', () => {
    render(<BrandShell brandName={null} brandCount={1}>{null}</BrandShell>);
    expect(screen.getByTestId('brand-shell-title').textContent).toBe('My practices');
  });

  it('makes no authority decision of its own', () => {
    const code = stripComments(read('app/brand/BrandShell.tsx'));
    expect(code).not.toMatch(/practice_group_members|redirect\(|notFound\(|from\(/);
  });
});

// ─── The single-source guard ───────────────────────────────────────────────

describe('nothing under app/brand hand-writes a nav link', () => {
  /** Every .ts/.tsx under app/brand, recursively. */
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  const FILES = walk(resolve(ROOT, 'app/brand'));
  const REL = (f: string) => f.slice(resolve(ROOT).length + 1).replace(/\\/g, '/');

  it('finds the brand tree (the walk is not vacuously empty)', () => {
    expect(FILES.length).toBeGreaterThan(8);
    expect(FILES.map(REL)).toContain('app/brand/brandNavLinks.ts');
  });

  it('only brandNavLinks.ts mentions the two tab routes that are pure navigation', () => {
    // /brand/practices and /brand/revenue are reachable ONLY as tabs. If a
    // second file names one, a second link list has started — the exact shape
    // of the bug that produced the practice side's shared link source.
    //
    // ONE allowed exception, and it is not a link: RevenueClient pushes
    // /brand/revenue?practice=… to put its own filter state in the URL. That is
    // a page navigating to ITSELF, it predates this nav, and the brief forbade
    // redesigning that screen. Listed by name so a THIRD naming of the route
    // still fails rather than being covered by a loose pattern.
    const ALLOWED = new Set([
      'app/brand/brandNavLinks.ts',
      'app/brand/revenue/RevenueClient.tsx',
    ]);
    for (const file of FILES) {
      const rel = REL(file);
      if (ALLOWED.has(rel)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(code, `${rel} names /brand/practices`).not.toMatch(/['"`]\/brand\/practices/);
      expect(code, `${rel} names /brand/revenue`).not.toMatch(/['"`]\/brand\/revenue/);
    }
  });

  it('the one allowed exception is a self-push, not a nav link', () => {
    // Guards the allowlist above: if RevenueClient ever grew a real <Link> to a
    // brand route, the exemption would be hiding exactly what it was written to
    // permit.
    const code = stripComments(read('app/brand/revenue/RevenueClient.tsx'));
    expect(code).toMatch(/router\.push\(`\/brand\/revenue\?/);
    expect(code).not.toMatch(/<Link/);
    expect(code).not.toMatch(/href=/);
  });

  it('BrandNav splices nothing of its own — it renders getBrandNavLinks() verbatim', () => {
    const code = stripComments(NAV_SRC);
    expect(code).toMatch(/getBrandNavLinks\(\)/);
    expect(code).toMatch(/links\.map/);
    // No literal href, and no local active-tab rule.
    expect(code).not.toMatch(/href="\/brand/);
    expect(code).not.toMatch(/pathname\.startsWith/);
    expect(code).toMatch(/isBrandNavActive/);
  });

  it('the retired back-link is gone from Settings — the nav is the way in and out', () => {
    const code = stripComments(read('app/brand/group/page.tsx'));
    expect(code).not.toMatch(/Back to my practices/);
    expect(code).toMatch(/BrandShell/);
  });

  it('ONE nav component exists, so there is no second surface to diverge from', () => {
    const navs = FILES.map(REL).filter((f) => /Nav\.tsx$/.test(f));
    expect(navs).toEqual(['app/brand/BrandNav.tsx']);
  });
});
