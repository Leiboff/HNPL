'use client';

import { useEffect, useRef } from 'react';

// ─── Peach COPYandPAY (paymentWidgets.js) mount — Flow B ONLY ───────
//
// This is the second door of our dual-door architecture (see
// lib/payments/peach/copyandpay/registration.ts for the full rationale).
// It renders Peach's legacy OPPWA COPYandPAY widget in registration-only
// mode — minimal card form, "Save card"-style button, no shopper
// email or billing fields, no amount displayed.
//
//   • Flow A (first-instalment CIT + future paying flows) uses the
//     newer PeachWidget (V2 embedded checkout) at
//     app/_components/PeachWidget.tsx — DO NOT reuse this component
//     for paying flows.
//
//   • Flow B (patient card-vault) uses THIS component. The server
//     creates a registration-only checkout via
//     createCardRegistration() and returns { checkoutId,
//     shopperResultUrl }; the widget POSTs to shopperResultUrl on
//     completion with ?resourcePath=/v1/checkouts/{id}/payment
//     appended (same suffix for payments and registrations).
//
// Env vars:
//   • NEXT_PUBLIC_PEACH_WIDGET_URL — browser origin for
//     paymentWidgets.js (sandbox: https://sandbox-card.peachpayments.com,
//     production: confirm from Dashboard). This is NOT a secret —
//     the checkoutId is per-transaction and short-lived, and the
//     server-side Bearer token stays server-side.

type Props = {
  checkoutId:       string;
  shopperResultUrl: string;
  // Comma-space separated brand list, e.g. 'VISA MASTER'. Peach docs
  // recommend keeping this exhaustive; the widget renders brand-
  // appropriate fields (e.g. CVV length) based on the card BIN.
  brands?:          string;
};

export default function PeachCopyAndPayWidget({
  checkoutId,
  shopperResultUrl,
  brands = 'VISA MASTER',
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const widgetHost = process.env.NEXT_PUBLIC_PEACH_WIDGET_URL;
    if (!widgetHost) {
      console.error('[PeachCopyAndPayWidget] NEXT_PUBLIC_PEACH_WIDGET_URL is not set');
      return;
    }

    // wpwlOptions lives on window — MUST be assigned BEFORE the
    // script tag mounts, else the widget picks up its own defaults.
    //
    // Brand styling: the widget renders inside an iframe, so brand
    // color has to travel via wpwlOptions.style (rather than page-
    // level CSS). We keep the wpwl-default `style: 'card'` (compact
    // single-line card form) and set locale to English-South-Africa.
    //
    // Button label: Peach's widget derives the button text from
    // whether an amount is present. A registration-only checkout
    // (no amount) renders "Save card" or similar by default — no
    // config knob to force it, so we intentionally do NOT set a
    // label override that could drift from the actual behaviour.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).wpwlOptions = {
      style:  'card',
      locale: 'en',
      // TODO(dina): once the sandbox flow renders, style overrides
      // (widget colour, corner radius) can be threaded via
      // wpwlOptions.paymentMethodsDisplay + custom CSS injected on
      // the surrounding page. Keeping this minimal until we've eyeballed
      // the default rendering on a real device.
    };

    const script       = document.createElement('script');
    script.src         = `${widgetHost.replace(/\/$/, '')}/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(checkoutId)}`;
    script.async       = true;
    script.crossOrigin = 'anonymous';
    document.body.appendChild(script);

    return () => {
      script.remove();
      // The widget attaches globals (wpwl*) — clean up so a re-mount
      // with a fresh checkoutId (retry) doesn't reuse stale state.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        delete w.wpwl;
        delete w.wpwlOptions;
      } catch { /* ignore */ }
    };
  }, [checkoutId]);

  return (
    <div ref={containerRef} data-testid="peach-copyandpay-widget">
      {/* The form's `class="paymentWidgets"` is what paymentWidgets.js
          hydrates. shopperResultUrl is where the widget POSTs on
          completion (server route reads the appended
          ?resourcePath=... to fetch final status). */}
      <form
        action={shopperResultUrl}
        className="paymentWidgets"
        data-brands={brands}
      />
    </div>
  );
}
