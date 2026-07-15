'use client';

import { useEffect, useRef } from 'react';

// ─── Peach Payments COPYandPAY widget mount ─────────────────────────
//
// Renders the OPPWA widget inline. Two use sites in the repo:
//
//   • Checkout bill-acceptance — the widget carries an amount + creates
//     a registration (INITIAL / CIT / UNSCHEDULED). The widget itself
//     handles card entry, tokenisation, and 3DS. On completion it POSTs
//     the shopperResultUrl (typically /checkout/{token}/complete) with
//     ?resourcePath=... appended; the server route reads that path and
//     asks Peach for the final status.
//
//   • Card management "add card" — the widget runs in registration-only
//     mode. The completion posts to /patient/payment-methods/complete.
//
// Both cases receive from the server:
//   • checkoutId       — the widget script's ?checkoutId=… parameter
//   • shopperResultUrl — where the widget POSTs on completion
//
// The `PEACH_BASE_URL` env var lives server-side; we surface the
// widget host via NEXT_PUBLIC_PEACH_WIDGET_URL because the browser
// needs to fetch the widget JS from that origin. That value is not a
// secret — the checkoutId is per-transaction and short-lived.

type Props = {
  checkoutId:        string;
  shopperResultUrl:  string;
  // Comma-space separated brand list, e.g. 'VISA MASTER'. Peach docs
  // recommend keeping this exhaustive; the widget itself will render
  // brand-appropriate fields.
  brands?:           string;
};

export default function PeachWidget({ checkoutId, shopperResultUrl, brands = 'VISA MASTER' }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const widgetHost = process.env.NEXT_PUBLIC_PEACH_WIDGET_URL;
    if (!widgetHost) {
      console.error('[PeachWidget] NEXT_PUBLIC_PEACH_WIDGET_URL is not set');
      return;
    }

    // wpwlOptions lives on window — set BEFORE the script mounts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).wpwlOptions = {
      style: 'card',
      locale: 'en',
    };

    const script = document.createElement('script');
    script.src = `${widgetHost.replace(/\/$/, '')}/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(checkoutId)}`;
    script.async = true;
    script.crossOrigin = 'anonymous';
    document.body.appendChild(script);

    return () => {
      script.remove();
      // The widget attaches globals (wpwl*) — clean up so a re-mount
      // (fresh checkoutId after a retry) doesn't reuse stale state.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        delete w.wpwl;
        delete w.wpwlOptions;
      } catch { /* ignore */ }
    };
  }, [checkoutId]);

  return (
    <div ref={containerRef} data-testid="peach-widget">
      <form
        action={shopperResultUrl}
        className="paymentWidgets"
        data-brands={brands}
      />
    </div>
  );
}
