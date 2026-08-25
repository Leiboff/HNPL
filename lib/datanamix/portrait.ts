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

// ── Why this is BEST-EFFORT, not fatal ─────────────────────────────────
//
// An earlier version of this module returned null whenever the resize
// failed, and callers treated null as "no usable biometric". That was
// wrong, and it broke production while passing every local test:
//
// sharp is a NATIVE module. The binary installed on a developer's
// Windows machine is not the one Vercel's linux-x64 serverless runtime
// needs, so `import('sharp')` can throw in production while working
// perfectly in dev — meaning 100% of applicants failed, invisibly.
//
// The deeper mistake was making an OPTIMISATION fatal. Resizing exists
// because Datanamix's portrait is larger than Didit's (~502KB observed
// live, versus ~40KB from Didit's DHA endpoint) and we would rather send
// less over the wire. But 502KB is already inside DHA_PORTRAIT_MAX_BYTES,
// so a failed resize is not a failed verification — the original image is
// still a perfectly good portrait to face-match against.
//
// So: if sharp cannot load or cannot re-encode, fall back to the ORIGINAL
// image and report it via `resized: false`. null is now reserved for the
// one case that genuinely means "no usable biometric": input that cannot
// be decoded into any image at all.

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
  /**
   * False when the resize could not run (sharp unavailable on this
   * platform, or an encode failure) and `base64` is therefore the
   * ORIGINAL image passed straight through. Verification still proceeds
   * — callers should log this, not reject on it.
   */
  resized:        boolean;
};

/**
 * Decode, downscale and re-encode a base64 portrait as JPEG.
 *
 * Returns null ONLY when the input cannot be decoded into an image at
 * all — that genuinely means "no usable biometric". A resize that fails
 * for any other reason returns the original image with resized: false,
 * because a large portrait is still a valid portrait.
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
      resized:       true,
    };
  } catch (err) {
    // Could not resize. Two very different causes, same safe answer:
    //   - sharp missing/incompatible on this platform (config problem)
    //   - the bytes are not a decodable image (genuinely unusable)
    // We cannot reliably distinguish them here, and getting it wrong in
    // the strict direction fails real applicants. So pass the original
    // through and let the size guard in createDhaFaceMatchSession be the
    // one thing that actually rejects on size.
    console.warn('[datanamix] portrait resize failed — passing original through', {
      bytes:  input.length,
      reason: err instanceof Error ? err.message : String(err),
    });
    return {
      base64:        input.toString('base64'),
      originalBytes: input.length,
      finalBytes:    input.length,
      resized:       false,
    };
  }
}
