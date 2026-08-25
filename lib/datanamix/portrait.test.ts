import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { downscalePortrait } from './portrait';

/**
 * Builds a base64 PNG of roughly the size Datanamix actually returns.
 * Observed live: 2,532,820 base64 chars (~1.9MB) — about 47x the ~40KB
 * Didit's DHA endpoint returns, and over the default 1MB
 * DHA_PORTRAIT_MAX_BYTES that createDhaFaceMatchSession enforces. Noise
 * is used rather than a flat colour so the PNG does not compress away
 * to nothing and the test exercises a genuinely large payload.
 */
async function bigPortraitBase64(edge = 1400): Promise<string> {
  const channels = 3 as const;
  const raw = Buffer.alloc(edge * edge * channels);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) % 251;
  const png = await sharp(raw, { raw: { width: edge, height: edge, channels } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  return png.toString('base64');
}

describe('downscalePortrait', () => {
  it('brings an oversized bureau portrait under the 1MB session cap', async () => {
    const original = await bigPortraitBase64();
    const originalBytes = Math.floor(original.length * 0.75);
    expect(originalBytes).toBeGreaterThan(1_000_000); // precondition

    const result = await downscalePortrait(original);
    expect(result).not.toBeNull();
    expect(result!.finalBytes).toBeLessThan(1_000_000);

    // The size guard in createDhaFaceMatchSession measures the base64
    // string, not the buffer, so assert on what it will actually see.
    expect(Math.floor(result!.base64.length * 0.75)).toBeLessThan(1_000_000);
  }, 30_000);

  it('caps the long edge and preserves aspect ratio', async () => {
    const src = await sharp({
      create: { width: 1200, height: 600, channels: 3, background: '#888' },
    }).png().toBuffer();

    const result = await downscalePortrait(src.toString('base64'), { maxEdge: 400 });
    expect(result).not.toBeNull();
    expect(result!.width).toBe(400);
    expect(result!.height).toBe(200);
  }, 30_000);

  it('never upscales an already-small portrait', async () => {
    // Didit's own DHA photo was ~40KB and matched at 97.24%; a small
    // portrait must pass through without being inflated.
    const src = await sharp({
      create: { width: 200, height: 200, channels: 3, background: '#444' },
    }).jpeg().toBuffer();

    const result = await downscalePortrait(src.toString('base64'), { maxEdge: 800 });
    expect(result!.width).toBe(200);
    expect(result!.height).toBe(200);
  }, 30_000);

  it('tolerates a data-URI prefix and embedded newlines', async () => {
    const src = await sharp({
      create: { width: 300, height: 300, channels: 3, background: '#123456' },
    }).png().toBuffer();
    const wrapped = `data:image/png;base64,${src.toString('base64').replace(/(.{40})/g, '$1\n')}`;

    const result = await downscalePortrait(wrapped);
    expect(result).not.toBeNull();
    expect(result!.width).toBe(300);
  }, 30_000);

  it('returns null for input that is not decodable as an image at all', async () => {
    // null is now reserved for "there is no image here" — the one case
    // that genuinely means no usable biometric.
    for (const bad of ['', '   ']) {
      expect(await downscalePortrait(bad)).toBeNull();
    }
  }, 30_000);

  it('passes the ORIGINAL through with resized:false when the resize cannot run', async () => {
    // Regression: an earlier version returned null on any resize failure,
    // and callers read null as "no usable biometric". sharp is a native
    // module, so it can be missing or ABI-incompatible on the deploy
    // platform while working perfectly in dev — that failed 100% of
    // production applicants invisibly. A failed OPTIMISATION must never
    // fail the verification.
    const notAnImage = Buffer.from('plain text, definitely not an image');
    const result = await downscalePortrait(notAnImage.toString('base64'));

    expect(result).not.toBeNull();
    expect(result!.resized).toBe(false);
    expect(Buffer.from(result!.base64, 'base64')).toEqual(notAnImage);
  }, 30_000);

  it('reports resized:true on the happy path', async () => {
    const src = await sharp({
      create: { width: 900, height: 900, channels: 3, background: '#abc' },
    }).png().toBuffer();
    const result = await downscalePortrait(src.toString('base64'));
    expect(result!.resized).toBe(true);
  }, 30_000);

  it('reports both original and final size so the shrink is auditable', async () => {
    const original = await bigPortraitBase64(1000);
    const result = await downscalePortrait(original);
    expect(result!.originalBytes).toBeGreaterThan(result!.finalBytes);
  }, 30_000);
});
