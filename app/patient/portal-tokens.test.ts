import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── The portal's palette, and the guard that keeps it one palette ──────
//
// WHY THIS FILE EXISTS. The patient portal was built with the right brand
// colours typed in by hand, one call site at a time, because the brand had
// no single statement anywhere: `--navy` and `--teal` lived in `.lp-root`
// (app/landing.css), scoped to the landing page, so every other surface
// re-typed the hex codes from memory. `.auth-surface` copied them with a
// comment saying "Brand, from app/landing.css". The portal copied them
// too, and then drifted:
//
//   • four navies — #13294B, #0E2140, #0B1F3A (the portal's own header
//     canvas, matching nothing) and #1B3A6C (one card's gradient)
//   • three teals — brand #15A89E, Tailwind's teal-800 #0F766E, and a
//     lighter #5CD9CE that was not --teal-bright
//   • ten blue-greys, for what is really a four-step text ramp
//   • five radii, where 22/14/7 is the actual scale and 18 and 15 were
//     each a couple of px from a step that already existed
//
// None of it was visible in review, because every individual value looked
// plausible next to the others. It is only visible in aggregate, which is
// what this test looks at.
//
// The accessibility half was invisible for the same reason. #8496AA is
// 2.82:1 on the portal's sheet, and it carried 11–13.5px help text, dates
// and payment amounts across 27 call sites; #A8B4C2 carried 11.5px text at
// 2.18:1. WCAG AA wants 4.5:1 at those sizes. The contrast block below is
// therefore not documentation — it is the assertion, so that changing a
// token value to something prettier and less legible fails here.

const GLOBALS = readFileSync('app/globals.css', 'utf8');
const LANDING = readFileSync('app/landing.css', 'utf8');

// ─── Contrast, computed rather than asserted from memory ───────────────

function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255)
       + 0.7152 * channel((n >> 8) & 255)
       + 0.0722 * channel(n & 255);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Resolve a token to its literal hex, following `var()` indirection.
 *
 * Most portal tokens deliberately point at a brand primitive rather than
 * restating a value (`--portal-ink: var(--brand-navy)`), which is the whole
 * design — so this has to chase the reference to get a colour to measure.
 */
function token(name: string, seen: string[] = []): string {
  if (seen.includes(name)) throw new Error(`--${name} is a var() cycle: ${seen.join(' → ')}`);
  const m = GLOBALS.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`--${name} is not defined in app/globals.css`);
  const value = m[1].trim();
  const hex = value.match(/^#[0-9A-Fa-f]{6}$/);
  if (hex) return value.toUpperCase();
  const ref = value.match(/^var\(\s*--([\w-]+)\s*\)$/);
  if (ref) return token(ref[1], [...seen, name]);
  throw new Error(`--${name} is neither a literal hex nor a single var(): ${value}`);
}

describe('brand primitives are stated exactly once', () => {
  it('globals.css :root holds them', () => {
    expect(token('brand-navy')).toBe('#13294B');
    expect(token('brand-navy-deep')).toBe('#0E2140');
    expect(token('brand-teal')).toBe('#15A89E');
    expect(token('brand-teal-bright')).toBe('#19C2B6');
  });

  it('--brand-teal-ink really is brand teal darkened, not another vendor’s teal', () => {
    // It replaced Tailwind's teal-800 (#0F766E). The value is our own teal
    // scaled to 70% luminance, which lands one unit of blue away — so the
    // pixels barely move, and the colour stops being someone else's.
    const teal = token('brand-teal');
    const ink  = token('brand-teal-ink');
    const rgb  = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const [tr, tg, tb] = rgb(teal);
    const [ir, ig, ib] = rgb(ink);
    for (const [scaled, actual] of [[tr * 0.7, ir], [tg * 0.7, ig], [tb * 0.7, ib]]) {
      expect(Math.abs(scaled - actual)).toBeLessThanOrEqual(1);
    }
  });

  it('.auth-surface REFERENCES the primitives instead of restating them', () => {
    const block = GLOBALS.slice(GLOBALS.indexOf('.auth-surface {'));
    const surface = block.slice(0, block.indexOf('}'));
    expect(surface).toMatch(/--auth-ground-from:\s*var\(--brand-navy-deep\)/);
    expect(surface).toMatch(/--auth-ground-to:\s*var\(--brand-navy\)/);
    expect(surface).toMatch(/--auth-teal:\s*var\(--brand-teal\)/);
    expect(surface).toMatch(/--auth-accent:\s*var\(--brand-teal-bright\)/);
    // The whole point: no literal brand hex left in the block.
    expect(stripComments(surface)).not.toMatch(/#0E2140|#13294B|#15A89E|#19[Cc]2[Bb]6/);
  });

  it('.lp-root references them too — it used to be the only statement of the brand', () => {
    const block = LANDING.slice(LANDING.indexOf('.lp-root {'));
    const root  = block.slice(0, block.indexOf('}'));
    expect(root).toMatch(/--navy:\s*var\(--brand-navy\)/);
    expect(root).toMatch(/--navy-deep:\s*var\(--brand-navy-deep\)/);
    expect(root).toMatch(/--teal:\s*var\(--brand-teal\)/);
    expect(root).toMatch(/--teal-bright:\s*var\(--brand-teal-bright\)/);
  });
});

describe('the portal text ramp is legible on the grounds it is used on', () => {
  // The portal renders text on three grounds. The sheet is the binding
  // constraint (it is the darkest of the three), but all are checked so a
  // future ground change cannot quietly break a step.
  const grounds = () => ({
    sheet: token('portal-sheet'),
    wash:  token('portal-wash'),
    card:  '#FFFFFF',
  });

  it.each([
    ['portal-ink',   7],    // headings and amounts — comfortably AAA
    ['portal-ink-2', 4.5],  // secondary text
    ['portal-muted', 4.5],  // muted body text at 11–13.5px, so AA applies
  ])('--%s clears %s:1 on every ground', (name, min) => {
    const fg = token(name);
    for (const [groundName, bg] of Object.entries(grounds())) {
      const ratio = contrast(fg, bg);
      expect(ratio, `${name} on ${groundName} (${bg}) = ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(min as number);
    }
  });

  it('--portal-faint is documented as decoration-only, because it cannot carry text', () => {
    // Kept as a token deliberately: icon strokes and dividers need a light
    // blue-grey, and giving it a name that says what it is NOT for is how
    // it stops being reached for as a text colour again.
    const faint = token('portal-faint');
    expect(contrast(faint, token('portal-sheet'))).toBeLessThan(4.5);
    const block = GLOBALS.slice(0, GLOBALS.indexOf('--portal-sheet'));
    expect(block).toMatch(/DECORATION ONLY/);
  });

  it('the ramp is monotonic — each step is lighter than the one before', () => {
    const steps = ['portal-ink', 'portal-ink-2', 'portal-muted', 'portal-faint']
      .map(n => relativeLuminance(token(n)));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i], `step ${i} must be lighter than step ${i - 1}`)
        .toBeGreaterThan(steps[i - 1]);
    }
  });

  it('--brand-teal-ink can carry text on the sheet, and --brand-teal cannot', () => {
    // This asymmetry is the entire reason -ink exists. If a future edit
    // makes brand teal light enough to "just use everywhere", this fails
    // and someone has to think about it.
    expect(contrast(token('brand-teal-ink'), token('portal-sheet'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('brand-teal'),     token('portal-sheet'))).toBeLessThan(4.5);
  });
});

// ─── The frozen inventory ───────────────────────────────────────────────
//
// Every hex literal left in app/patient/** is listed here, by family. A new
// one fails this test — which is the mechanism, not an inconvenience. The
// portal drifted precisely because adding one more nearly-right hex was
// always easier than finding the token, and nothing ever objected.
//
// To add a colour: if it belongs to the brand or the text ramp, use the
// token. If it is genuinely a new SEMANTIC state, add it below with a note
// saying which state it serves.

const ALLOWED_HEX = new Set([
  '#FFFFFF',                                             // white
  // Overdue / failed / declined
  '#B42318', '#8A1F1F', '#7A1F1F', '#8A2B22', '#FF6B5A', '#FEF6F5', '#FCEAEA',
  // Attention / pending amber
  '#B45309', '#8A5A11', '#F5A524', '#F59E0B', '#F5D49A', '#FBE5C8', '#EDE0C6',
  // Paid / success green
  '#1E7A45', '#16A34A', '#059669', '#F0FDF4', '#E7F6EC',
  // Processing / due today / upcoming — the info-blue status pair. Shares a
  // hue with brand navy, which is why the guard below is an allowlist and
  // not a hue test: no classifier can tell these from the brand.
  '#EAF1FB', '#2B5FA8',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.tsx') && !full.includes('.test.') ? [full] : [];
  });
}

describe('no raw hex survives in the patient portal', () => {
  const files = sourceFiles('app/patient');

  it('finds the portal source (a broken walk would pass everything trivially)', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(files)('%s uses tokens for every brand and ramp colour', file => {
    const code = stripComments(readFileSync(file, 'utf8'), { jsxBraces: true });
    const offenders = [...code.matchAll(/#[0-9A-Fa-f]{6}\b/g)]
      .map(m => m[0].toUpperCase())
      .filter(hex => !ALLOWED_HEX.has(hex));
    expect(offenders, `use a --portal-*/--brand-* token, or add a semantic entry to ALLOWED_HEX`)
      .toEqual([]);
  });

  it('the radius scale replaced the arbitrary values', () => {
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'), { jsxBraces: true });
      expect(code, `${file} should use rounded-card / rounded-tile / rounded-chip`)
        .not.toMatch(/rounded-\[\d+px\]/);
    }
  });

  it('var() never appears in an SVG presentation attribute, where it does not resolve', () => {
    // A presentation attribute is not a CSS declaration, so `stroke="var(…)"`
    // silently paints nothing. The migration moved these to inline `style`,
    // which is CSS. Pinned because the attribute form looks correct.
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      expect(code, `${file}: use style={{ stroke: 'var(…)' }} instead`)
        .not.toMatch(/(?:stroke|fill)="var\(/);
    }
  });
});
