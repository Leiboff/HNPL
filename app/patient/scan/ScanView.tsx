'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import jsQR from 'jsqr';

// ─── ScanView — camera QR scanner for /patient/scan ──────────────────────
//
// Reads the same URL shape BillQrPanel encodes: `${origin}/checkout/{token}`
// (see app/practice/bills/new/BillQrPanel.tsx). A successful decode just
// pushes the patient straight into the existing /checkout/[token] flow —
// this page does no claiming or lookup of its own.
//
// Decoding used to go through the browser's Shape Detection API
// (`BarcodeDetector`) — Chrome/Android only. Safari has never implemented
// it, on iOS or macOS, which meant this page silently did nothing useful
// for a large share of patients. jsQR is a pure-JS decoder that only needs
// a <canvas> and getUserMedia — both supported since iOS 11 — so it works
// the same way everywhere. The manual-entry field stays as the fallback
// for the cases even that can't cover (camera denied, no camera at all).

type Status = 'starting' | 'scanning' | 'denied' | 'unsupported' | 'redirecting';

/** How often to pull a frame and try to decode it. jsQR is real CPU work
    (pixel-by-pixel pattern matching), so this runs on a timer rather than
    every animation frame — 5/s is plenty responsive for a code someone is
    deliberately holding still. */
const SCAN_INTERVAL_MS = 200;

/** Frames are downscaled to this before decoding. Too small and a
    real-world photographed code (angled, at arm's length, some motion
    blur) loses the module detail jsQR needs; too large costs CPU for no
    benefit, since QR detection doesn't need the camera's native
    resolution (often 1080p+ on a phone). */
const MAX_SCAN_DIMENSION = 640;

/** How long the "that's not a BetterNow code" hint stays up after a
    decode that resolves to nothing useful. */
const WRONG_CODE_HINT_MS = 2500;

/** Pull a /checkout/:token destination out of whatever we're handed — a
    full URL (what a QR encodes), a bare path, or a raw token (manual
    entry, read off a printed bill). */
function resolveDestination(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    // Not a URL — fall through and try it as a path or bare token.
  }

  if (pathname.startsWith('/checkout/')) return pathname;
  if (/^[A-Za-z0-9_-]{8,}$/.test(value)) return `/checkout/${encodeURIComponent(value)}`;
  return null;
}

export default function ScanView({ availableLabel }: {
  /** Formatted available balance, or null when the patient has no
   *  approved limit. Never a placeholder — a figure on this screen is a
   *  promise about what can be spent at the counter, and with no limit
   *  there isn't one to make. */
  availableLabel: string | null;
}) {
  const router = useRouter();
  const videoRef       = useRef<HTMLVideoElement>(null);
  const streamRef       = useRef<MediaStream | null>(null);
  const foundRef         = useRef(false);
  const hintTimeoutRef    = useRef<number | null>(null);

  const [status, setStatus]           = useState<Status>('starting');
  const [manual, setManual]           = useState('');
  const [showManual, setShowManual]   = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  // Distinguishes "nothing is being detected" from "something was
  // detected but it isn't a checkout code" — without this, both look
  // identical to a patient (and to us, diagnosing a report that scanning
  // "doesn't pick anything up").
  const [wrongCodeHint, setWrongCodeHint] = useState(false);

  const go = useCallback((dest: string) => {
    foundRef.current = true;
    setStatus('redirecting');
    router.push(dest);
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    let intervalId: number | null = null;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('unsupported');
        return;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch {
        if (!cancelled) setStatus('denied');
        return;
      }

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setStatus('scanning');

      // Offscreen — never attached to the DOM, purely a scratch buffer for
      // pulling pixel data out of the <video> element each tick.
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      // The browser's default smoothing blurs the downscale, which softens
      // exactly the sharp module edges jsQR relies on. Nearest-neighbour
      // keeps them crisp.
      if (ctx) ctx.imageSmoothingEnabled = false;

      const scanTick = () => {
        if (foundRef.current || !ctx || !videoRef.current) return;
        const video = videoRef.current;
        if (video.readyState < video.HAVE_ENOUGH_DATA || !video.videoWidth) return;

        const scale = Math.min(1, MAX_SCAN_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
        const w = Math.max(1, Math.round(video.videoWidth * scale));
        const h = Math.max(1, Math.round(video.videoHeight * scale));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);

        let imageData: ImageData;
        try {
          imageData = ctx.getImageData(0, 0, w, h);
        } catch {
          return;
        }

        // attemptBoth: costs a bit more per frame than dontInvert, but at a
        // 200ms cadence (not every animation frame) there's headroom to
        // spend on not missing a real code over a light/dark background we
        // didn't anticipate.
        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
        if (!code?.data) return;

        const dest = resolveDestination(code.data);
        if (dest) {
          if (intervalId !== null) { window.clearInterval(intervalId); intervalId = null; }
          go(dest);
          return;
        }

        // A QR WAS read — the camera and decoder are working — it just
        // isn't a BetterNow checkout code. Say so, rather than looking
        // identical to "nothing detected" and leaving the patient guessing
        // whether to keep trying or give up on scanning entirely.
        setWrongCodeHint(true);
        if (hintTimeoutRef.current !== null) window.clearTimeout(hintTimeoutRef.current);
        hintTimeoutRef.current = window.setTimeout(() => setWrongCodeHint(false), WRONG_CODE_HINT_MS);
      };

      intervalId = window.setInterval(scanTick, SCAN_INTERVAL_MS);
    }

    start();

    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
      if (hintTimeoutRef.current !== null) window.clearTimeout(hintTimeoutRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [go]);

  function submitManual(e: FormEvent) {
    e.preventDefault();
    const dest = resolveDestination(manual);
    if (!dest) {
      setManualError("That doesn't look like a BetterNow checkout code.");
      return;
    }
    setManualError(null);
    go(dest);
  }

  const showVideo = status === 'scanning' || status === 'redirecting';

  // The manual field is folded away behind a quiet text button — UNLESS
  // the camera cannot run, in which case it is the only way through this
  // screen and opens expanded. A fallback you have to discover is not a
  // fallback.
  const cameraUnavailable = status === 'denied' || status === 'unsupported';
  const manualOpen = showManual || cameraUnavailable;

  return (
    <div className="flex flex-col items-center">
      <p className="mt-[18px] text-[16px] font-semibold text-white">Scan to pay at the counter</p>
      <p className="mt-2 px-6 max-w-[290px] text-center text-[13px] leading-[1.6]" style={{ color: 'rgba(255,255,255,.5)' }}>
        Point your camera at the practice&apos;s betternow QR. Your available balance and plan
        options appear before you commit.
      </p>

      {/* ── Viewfinder ──────────────────────────────────────────────────
          A fixed square with teal corner brackets rather than a 3/4 frame
          with a punched-out hole. The brackets are the thing a person
          aims with: they say where the code goes without a 999px black
          spread darkening the whole screen to draw a hole in it. */}
      <div
        className="relative mt-[30px] w-[246px] h-[246px] overflow-hidden"
        style={{ borderRadius: 28, background: 'rgba(255,255,255,.04)' }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-cover"
          style={{ opacity: showVideo ? 1 : 0 }}
        />

        {/* Diagonal teal wash — reads as a lens rather than a hole while
            the camera is starting, denied, or unsupported. */}
        {!showVideo && (
          <div
            aria-hidden
            className="absolute inset-0"
            style={{ background: 'linear-gradient(140deg,rgba(25,194,182,.16),transparent 60%)' }}
          />
        )}

        {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
          <Bracket key={corner} corner={corner} tone={wrongCodeHint ? '#F5A524' : 'var(--brand-teal-bright)'} />
        ))}

        {status === 'starting' && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] font-medium" style={{ color: 'rgba(255,255,255,.6)' }}>
            Starting camera…
          </div>
        )}

        {status === 'redirecting' && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] font-medium text-white" style={{ background: 'rgba(7,16,31,.55)' }}>
            Code found — opening…
          </div>
        )}

        {status === 'denied' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-[13.5px] font-semibold text-white">Camera access is off</p>
            <p className="text-[12.5px] leading-[1.5]" style={{ color: 'rgba(255,255,255,.6)' }}>
              Turn it on for betternow in your browser or phone settings, or enter the code from the bill.
            </p>
          </div>
        )}

        {status === 'unsupported' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-[13.5px] font-semibold text-white">Scanning isn&apos;t available here</p>
            <p className="text-[12.5px] leading-[1.5]" style={{ color: 'rgba(255,255,255,.6)' }}>
              Enter the code from the bill instead.
            </p>
          </div>
        )}
      </div>

      {status === 'scanning' && wrongCodeHint && (
        <p
          className="mt-4 rounded-full px-3.5 py-2 text-[12.5px] font-medium text-white text-center"
          style={{ background: 'rgba(180,90,10,.85)' }}
          role="status"
        >
          That QR isn&apos;t a betternow checkout code
        </p>
      )}

      {/* The balance, at the counter. This is the number a patient is
          about to be asked to commit against, and standing at a till is
          precisely where they cannot go and look it up. Rendered only
          when there IS an approved limit — never a placeholder figure. */}
      {availableLabel && (
        <div
          className="mt-[26px] flex items-center gap-3 px-[18px] py-[14px]"
          style={{ borderRadius: 16, background: 'rgba(255,255,255,.06)' }}
        >
          <span className="text-[12px]" style={{ color: 'rgba(255,255,255,.55)' }}>Available to spend</span>
          <span className="text-[15px] font-semibold text-white tabular-nums">{availableLabel}</span>
        </div>
      )}

      {!manualOpen ? (
        <button
          type="button"
          onClick={() => setShowManual(true)}
          className="mt-[14px] text-[13px] font-medium"
          style={{ color: 'rgba(255,255,255,.55)' }}
        >
          Enter a code instead
        </button>
      ) : (
        <form onSubmit={submitManual} className="mt-[22px] w-full max-w-[320px] px-4 flex flex-col gap-2">
          <label htmlFor="scan-manual-code" className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.14em', color: 'rgba(255,255,255,.45)' }}>
            Code from your bill
          </label>
          <div className="flex gap-2">
            <input
              id="scan-manual-code"
              value={manual}
              onChange={(e) => { setManual(e.target.value); setManualError(null); }}
              placeholder="e.g. 7FQ2-8KDP"
              autoComplete="off"
              autoCapitalize="characters"
              className="flex-1 min-w-0 rounded-tile px-4 py-3 text-[15px] text-white placeholder:text-white/35"
              style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.14)' }}
            />
            <button
              type="submit"
              className="bn-btn-teal flex-none rounded-tile px-5 text-[15px] font-semibold text-white"
            >
              Go
            </button>
          </div>
          {manualError && (
            <p className="text-[13px] font-medium" style={{ color: '#FF6B5A' }} role="alert">{manualError}</p>
          )}
        </form>
      )}
    </div>
  );
}

// ─── Viewfinder corner bracket ───────────────────────────────────────────
//
// Four of these make the frame. Each is an L drawn with two borders on one
// corner of a 44px box, rounded on its outer corner only, so together they
// read as a rounded rectangle with its sides removed.
function Bracket({ corner, tone }: { corner: 'tl' | 'tr' | 'bl' | 'br'; tone: string }) {
  const edge = `3px solid ${tone}`;
  const base: React.CSSProperties = { position: 'absolute', width: 44, height: 44, transition: 'border-color .15s' };
  const byCorner: Record<typeof corner, React.CSSProperties> = {
    tl: { top: 0, left: 0,  borderTop: edge,    borderLeft: edge,  borderRadius: '18px 0 0 0' },
    tr: { top: 0, right: 0, borderTop: edge,    borderRight: edge, borderRadius: '0 18px 0 0' },
    bl: { bottom: 0, left: 0,  borderBottom: edge, borderLeft: edge,  borderRadius: '0 0 0 18px' },
    br: { bottom: 0, right: 0, borderBottom: edge, borderRight: edge, borderRadius: '0 0 18px 0' },
  };
  return <span aria-hidden style={{ ...base, ...byCorner[corner] }} />;
}
