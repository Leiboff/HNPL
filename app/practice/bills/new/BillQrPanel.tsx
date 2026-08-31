'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// ─── The dashboard's QR delivery surface ─────────────────────────────────
//
// The till's CounterSessionForm renders the same code, but it can also
// call expireCounterSession — that action authenticates with a DEVICE
// SECRET, which a dashboard user does not have and must not be given.
// This panel therefore only DISPLAYS the countdown; expiry is left to
// expire_stale_checkout_session (migration 0085), which every meaningful
// next touch of the token already invokes as a lazy fail-safe. A code that
// times out here stops working server-side whether or not this tab is
// still open.
//
// Nothing about the patient appears here. The token is the scannable
// secret and the only thing the server returned.

export default function BillQrPanel({
  token,
  expiresAt,
}: {
  token:     string;
  expiresAt: string;
}) {
  const [qrDataUrl,   setQrDataUrl]   = useState<string | null>(null);
  const [qrError,     setQrError]     = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [copied,      setCopied]      = useState(false);

  // Derived, not stateful: `window` exists by the time this client
  // component ever actually renders this branch, so there's no async gap
  // to bridge with an effect the way qrDataUrl (an awaited encode) needs.
  const checkoutUrl = typeof window !== 'undefined' ? `${window.location.origin}/checkout/${token}` : null;

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(`${window.location.origin}/checkout/${token}`, { width: 320, margin: 1 })
      .then((dataUrl) => { if (!cancelled) setQrDataUrl(dataUrl); })
      .catch(() => { if (!cancelled) setQrError(true); });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    const tick = () =>
      setSecondsLeft(Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  const expired = secondsLeft !== null && secondsLeft <= 0;

  return (
    <div
      data-testid="bill-qr-panel"
      className="rounded-card border border-[var(--portal-line-soft)] bg-white p-5 sm:p-6 space-y-3 text-center"
    >
      {expired ? (
        <p data-testid="bill-qr-expired" className="text-sm font-medium text-[#8A1F1F]">
          This QR code has expired. Create the bill again to issue a new one.
        </p>
      ) : qrError ? (
        <p data-testid="bill-qr-error" className="text-sm font-medium text-[#8A1F1F]">
          Could not render the QR code. Create the bill again to issue a new one.
        </p>
      ) : (
        <>
          <p className="text-sm text-[var(--portal-ink-2)]">Ask the patient to scan this with their phone camera.</p>
          {qrDataUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qrDataUrl}
              alt="Checkout QR code"
              data-testid="bill-qr-image"
              className="mx-auto w-[220px] h-[220px]"
            />
          )}
          {secondsLeft !== null && (
            <p data-testid="bill-qr-countdown" className="text-xs tabular-nums text-[var(--portal-muted)]">
              Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
            </p>
          )}

          {/* Camera scanning isn't available on every phone (notably
              Safari/iOS lacks the barcode-detection API the in-app scanner
              needs), and this is the ONLY place the underlying link exists —
              without it, a patient who can't scan has no way to reach
              checkout at all. Read aloud or copied into a message, it's the
              fallback path. */}
          {checkoutUrl && (
            <div className="pt-1 text-left">
              <p className="text-xs text-[var(--portal-muted)]">Can&apos;t scan? Send this link instead</p>
              <div className="mt-1.5 flex gap-2">
                <input
                  readOnly
                  value={checkoutUrl}
                  data-testid="bill-qr-link"
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--portal-line-soft)] bg-[var(--portal-wash)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--portal-ink-2)]"
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(checkoutUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    } catch {
                      // Clipboard access can be denied/unavailable — the
                      // input above is still selectable by hand.
                    }
                  }}
                  className="flex-none rounded-lg bg-[var(--portal-ink)] px-3 py-1.5 text-xs font-medium text-white"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
