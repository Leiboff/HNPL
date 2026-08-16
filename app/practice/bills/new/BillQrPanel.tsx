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

  useEffect(() => {
    const url = `${window.location.origin}/checkout/${token}`;
    let cancelled = false;
    QRCode.toDataURL(url, { width: 320, margin: 1 })
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
      className="rounded-[20px] border border-[#E5E9F0] bg-white p-5 sm:p-6 space-y-3 text-center"
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
          <p className="text-sm text-[#3A4B66]">Ask the patient to scan this with their phone camera.</p>
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
            <p data-testid="bill-qr-countdown" className="text-xs tabular-nums text-[#7A8AA0]">
              Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
