// ─── pnpm marketing:device-approved ──────────────────────────────────────
//
// Regenerates public/marketing/device-approved.png, the phone on the landing
// page's "How it works" section. See scripts/marketing/README.md.
//
//   pnpm marketing:device-approved            write the PNG
//   pnpm marketing:device-approved --verify   capture twice, fail if the two
//                                             differ by more than 0.1%
//   --out <path>                              write somewhere else instead
//
// The capture itself asserts what the image must never show: a fallback font
// on the headline figure (checked against the glyphs Chrome actually drew),
// or any "Pay in 2" copy.
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeScreenDocument } from './render';
import { frameScreenshot, SCREEN } from './frame';
import { FIXTURE } from './fixtures';

const REPO = path.resolve(import.meta.dirname, '../..');
const DEFAULT_OUT = path.join(REPO, 'public/marketing/device-approved.png');
const SCALE = 3;
const PAY_IN_2 = /pay[\s-]?in[\s-]?2/i;

async function captureOnce(): Promise<Buffer> {
  const doc = await writeScreenDocument();
  // CHROMIUM_PATH overrides; otherwise playwright-core's own install
  // (`pnpm exec playwright-core install chromium`) or PLAYWRIGHT_BROWSERS_PATH.
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const context = await browser.newContext({
      viewport:          { width: SCREEN.width / SCALE, height: SCREEN.height / SCALE },
      deviceScaleFactor: SCALE,
      reducedMotion:     'reduce',
      locale:            'en-ZA',
      timezoneId:        'Africa/Johannesburg',
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(FIXTURE.clock));
    await page.goto(pathToFileURL(doc).href);
    await page.evaluate(() => document.fonts.ready);

    const check = await page.evaluate(() => {
      const figure = document.querySelector('[data-testid="approved-allowance"]');
      return {
        figure:     figure?.textContent ?? null,
        fontFamily: figure ? getComputedStyle(figure).fontFamily : null,
        text:       document.body.innerText.replace('09:41', ''),
      };
    });
    if (!check.figure) throw new Error('capture: balance figure not found on the screen');
    if (PAY_IN_2.test(check.text)) throw new Error('capture: screen text mentions Pay in 2');

    // The font that actually drew the figure's glyphs. Computed font-family
    // only echoes the declared stack, and document.fonts.check() is true when
    // no Poppins face exists at all — neither catches a silent fallback.
    const cdp = await context.newCDPSession(page);
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="approved-allowance"]' });
    await cdp.send('CSS.enable');
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    const used = fonts.map((f) => f.familyName);
    if (used.length === 0 || used.some((name) => name !== 'Poppins')) {
      throw new Error(`capture: balance figure rendered in ${used.join(', ') || 'nothing'}, not Poppins (declared: ${check.fontFamily})`);
    }
    console.log(`captured ${check.figure} · glyphs drawn in ${used.join(', ')} · no Pay-in-2 copy`);

    return await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
  } finally {
    await browser.close();
  }
}

/** Fraction of pixels whose RGBA differs between two same-sized PNGs. */
async function pixelDiff(a: Buffer, b: Buffer): Promise<number> {
  const [ra, rb] = await Promise.all([a, b].map((x) => sharp(x).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return 1;
  let differing = 0;
  for (let i = 0; i < ra.data.length; i += 4) {
    if (ra.data[i] !== rb.data[i] || ra.data[i + 1] !== rb.data[i + 1] ||
        ra.data[i + 2] !== rb.data[i + 2] || ra.data[i + 3] !== rb.data[i + 3]) differing++;
  }
  return differing / (ra.info.width * ra.info.height);
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : DEFAULT_OUT;

  const png = await frameScreenshot(await captureOnce());

  if (args.includes('--verify')) {
    const again = await frameScreenshot(await captureOnce());
    const diff = await pixelDiff(png, again);
    console.log(`determinism: ${(diff * 100).toFixed(4)}% of pixels differ between two runs`);
    if (diff > 0.001) throw new Error('capture is not deterministic (> 0.1% of pixels differ)');
  }

  await writeFile(out, png);
  const meta = await sharp(png).metadata();
  console.log(`wrote ${path.relative(REPO, out)} · ${meta.width}×${meta.height} · ${(png.length / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
