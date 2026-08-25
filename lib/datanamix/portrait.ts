// SERVER-ONLY. Never import in a client component.
//
// Datanamix returns a MUCH larger portrait than Didit's DHA endpoint:
// ~2.53M base64 chars (~1.9MB) observed, versus ~54k chars (~40KB) from
// Didit. That is over the default DHA_PORTRAIT_MAX_BYTES (1MB), so
// createDhaFaceMatchSession would throw before the session was ever
// created — and Didit's own portrait_image size limit has never been
// confirmed, so a 1.9MB payload may be rejected on their side too.
//
// Face matching does not need that resolution. Didit's own 40KB registry
// photo scored 97.24% against a live selfie. Downscaling to a sane size
// is safe and makes the payload predictable.
//
// If the image cannot be decoded or re-encoded, this returns null rather
// than the original oversized buffer. Returning the original would just
// move the failure downstream into createDhaFaceMatchSession's size
// guard, where the cause is much harder to see. A null here routes to
// ocr_fallback (biometric_image_unusable) — the person is real and on
// the register, we just cannot run the biometric check on this image.

// sharp is imported DYNAMICALLY, inside the function. It is a native
// module and (currently) only a transitive Next.js dependency, so a
// top-level import makes every test file that touches this module's
// import graph fail to resolve — including the pure routing tests, which
// never downscale anything. Add it as an explicit dependency
// (`pnpm add sharp`) before relying on this in production; a transitive
// dep can vanish on any Next.js upgrade.

/** Long-edge pixels. 800px is comfortably enough for face matching. */
const DEFAULT_MAX_EDGE = 800;
/** JPEG quality. 82 is visually clean and compresses hard. */
const DEFAULT_QUALITY = 82;

export type DownscaleResult = {
  base64:         string;
  originalBytes:  number;
  finalBytes:     number;
  width?:         number;
  height?:        number;
};

/**
 * Decode, downscale and re-encode a base64 portrait as JPEG.
 * Returns null if the image is unusable — callers must treat null as
 * "no usable biometric", never as "skip the check".
 */
export async function downscalePortrait(
  imageBase64: string,
  opts: { maxEdge?: number; quality?: number } = {},
): Promise<DownscaleResult | null> {
  if (!imageBase64) return null;

  const maxEdge = opts.maxEdge ?? Number(process.env.DNX_PORTRAIT_MAX_EDGE ?? DEFAULT_MAX_EDGE);
  const quality = opts.quality ?? Number(process.env.DNX_PORTRAIT_JPEG_QUALITY ?? DEFAULT_QUALITY);

  let input: Buffer;
  try {
    // Tolerate data-URI prefixes and embedded whitespace/newlines.
    const cleaned = imageBase64.replace(/^data:image\/[a-z+]+;base64,/i, '').replace(/\s+/g, '');
    input = Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
  if (input.length === 0) return null;

  try {
    const { default: sharp } = await import('sharp');
    const output = await sharp(input)
      // withoutEnlargement: a portrait already smaller than maxEdge is
      // re-encoded but never upscaled — upscaling adds bytes and no
      // information.
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    return {
      base64:        output.data.toString('base64'),
      originalBytes: input.length,
      finalBytes:    output.data.length,
      width:         output.info.width,
      height:        output.info.height,
    };
  } catch {
    // Corrupt, truncated, or an unsupported format. Explicitly not a
    // fallback to the original buffer — see the header comment.
    return null;
  }
}
