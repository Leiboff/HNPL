// ─── Device frame ────────────────────────────────────────────────────────
//
// Drawn, not traced from the old PNG, so the corners are exactly transparent:
// alpha 0 everywhere outside the phone outline, antialiased on the edge. The
// previous image baked a soft shadow into its whole rectangle, which showed as
// a grey box where it overlapped the landing page's mint orbit.
//
// Geometry matches the previous image so the page layout does not move:
// 1260×2580 overall, 42px bezel, 160px outer radius, 118px screen radius.
import sharp from 'sharp';

export const FRAME = {
  width:       1260,
  height:      2580,
  bezel:       42,
  outerRadius: 160,
  innerRadius: 118,
  colour:      '#0D1B2A',
  camera:      { cx: 630, cy: 108, r: 18 },
} as const;

/** Screenshot size the frame expects: exactly the screen opening. */
export const SCREEN = {
  width:  FRAME.width - 2 * FRAME.bezel,
  height: FRAME.height - 2 * FRAME.bezel,
} as const;

const svg = (w: number, h: number, body: string) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`);

/** Composite a SCREEN-sized screenshot into the frame; returns PNG bytes. */
export async function frameScreenshot(screenshot: Buffer): Promise<Buffer> {
  const meta = await sharp(screenshot).metadata();
  if (meta.width !== SCREEN.width || meta.height !== SCREEN.height) {
    throw new Error(`screenshot is ${meta.width}×${meta.height}, expected ${SCREEN.width}×${SCREEN.height}`);
  }

  const screen = await sharp(screenshot)
    .ensureAlpha()
    .composite([{
      input: svg(SCREEN.width, SCREEN.height,
        `<rect width="${SCREEN.width}" height="${SCREEN.height}" rx="${FRAME.innerRadius}" fill="#fff"/>`),
      blend: 'dest-in',
    }])
    .png()
    .toBuffer();

  const { cx, cy, r } = FRAME.camera;
  return sharp(svg(FRAME.width, FRAME.height,
      `<rect width="${FRAME.width}" height="${FRAME.height}" rx="${FRAME.outerRadius}" fill="${FRAME.colour}"/>`))
    .composite([
      { input: screen, left: FRAME.bezel, top: FRAME.bezel },
      { input: svg(FRAME.width, FRAME.height, `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${FRAME.colour}"/>`), left: 0, top: 0 },
    ])
    // Lossless: full RGBA, maximum zlib effort, adaptive row filtering.
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer();
}
