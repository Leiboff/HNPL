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

/** Frames are downscaled to this before decoding. QR detection doesn't
    need the camera's native resolution (often 1080p+ on a phone) and
    decoding a smaller frame is substantially faster. */
const MAX_SCAN_DIMENSION = 480;

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

export default function ScanView() {
  const router = useRouter();
  const videoRef  = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const foundRef  = useRef(false);

  const [status, setStatus]           = useState<Status>('starting');
  const [manual, setManual]           = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

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

        // dontInvert: a checkout QR is always dark-on-light, and skipping
        // jsQR's inverted-image pass roughly halves the work per frame.
        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
        const dest = code?.data ? resolveDestination(code.data) : null;
        if (dest) {
          if (intervalId !== null) { window.clearInterval(intervalId); intervalId = null; }
          go(dest);
        }
      };

      intervalId = window.setInterval(scanTick, SCAN_INTERVAL_MS);
    }

    start();

    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
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

  return (
    <div className="flex flex-col gap-4">
      <div
        className="relative w-full overflow-hidden rounded-[22px] bg-[#0B1F3A]"
        style={{ aspectRatio: '3 / 4' }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-cover"
          style={{ opacity: showVideo ? 1 : 0 }}
        />

        {status === 'scanning' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div
              className="h-[62%] w-[62%] rounded-[18px]"
              style={{ border: '3px solid rgba(255,255,255,.85)', boxShadow: '0 0 0 999px rgba(0,0,0,.28)' }}
            />
          </div>
        )}

        {status === 'starting' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm font-medium text-white/70">
            Starting camera…
          </div>
        )}

        {status === 'redirecting' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm font-medium text-white" style={{ background: 'rgba(11,31,58,.55)' }}>
            Code found — opening…
          </div>
        )}

        {status === 'denied' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm font-medium text-white">Camera access is off</p>
            <p className="text-[13px] text-white/70">
              Turn it on for BetterNow in your browser or phone settings, or enter the code from the bill below.
            </p>
          </div>
        )}

        {status === 'unsupported' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm font-medium text-white">Camera scanning isn&apos;t available on this device</p>
            <p className="text-[13px] text-white/70">Enter the code from the bill below instead.</p>
          </div>
        )}
      </div>

      <p className="text-center text-[13px]" style={{ color: '#7A8AA0' }}>
        Point your camera at the QR code on your bill or the practice&apos;s till screen.
      </p>

      <form onSubmit={submitManual} className="flex flex-col gap-2">
        <label className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.1em', color: 'rgba(19,41,75,.5)' }}>
          Can&apos;t scan? Enter the code
        </label>
        <div className="flex gap-2">
          <input
            value={manual}
            onChange={(e) => { setManual(e.target.value); setManualError(null); }}
            placeholder="Code from your bill"
            className="flex-1 rounded-[14px] border px-4 py-3 text-[15px]"
            style={{ borderColor: 'rgba(19,41,75,.15)' }}
          />
          <button
            type="submit"
            className="rounded-[14px] px-5 text-[15px] font-semibold text-white"
            style={{ background: '#15A89E' }}
          >
            Go
          </button>
        </div>
        {manualError && (
          <p className="text-[13px] font-medium" style={{ color: '#8A1F1F' }}>{manualError}</p>
        )}
      </form>
    </div>
  );
}
