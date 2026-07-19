'use client';

import { useEffect, useRef } from 'react';

// ─── Peach Checkout V2 embedded widget mount ────────────────────────
//
// Renders the V2 embedded component in-page. Two use sites in the repo:
//
//   • Checkout bill-acceptance — the widget carries an amount + creates
//     a registration (INITIAL / INSTALLMENT / CIT). On onCompleted the
//     browser navigates to shopperResultUrl?checkoutId={id}; the server
//     route reads the checkoutId and asks Peach's V2 status API for
//     the final result.
//
//   • Card management "add card" — the widget runs in registration-only
//     mode. onCompleted navigates to /patient/payment-methods/complete
//     with the same checkoutId param.
//
// checkout.js loads the V2 embedded component. `PEACH_CHECKOUT_ENTITY_ID`
// is surfaced from the server via NEXT_PUBLIC_PEACH_CHECKOUT_ENTITY_ID
// — not a secret (the entity id is a public identifier used by the
// widget). The bearer token used to CREATE the checkout stays on the
// server; the browser only ever holds the short-lived checkoutId.

type Props = {
  checkoutId:        string;
  entityId:          string;         // The Checkout V2 `key` — public.
  shopperResultUrl:  string;         // Where onCompleted navigates.
};

// Loose Checkout shape — checkout.js is loaded at runtime; we don't have
// its types. The V2 API is:
//   const checkout = Checkout.initiate({ key, checkoutId, events });
//   checkout.render('#payment-form');
//
// Events fire on completion, cancellation, or expiry.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CheckoutGlobal = { initiate: (opts: unknown) => { render: (sel: string) => void } };

export default function PeachWidget({ checkoutId, entityId, shopperResultUrl }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const src = process.env.NEXT_PUBLIC_PEACH_CHECKOUT_JS;
    if (!src) {
      console.error('[PeachWidget] NEXT_PUBLIC_PEACH_CHECKOUT_JS is not set');
      return;
    }

    // Navigate back to the server for status verification. The server
    // reads the checkoutId query param and calls Peach's V2 status API.
    const navigateBack = (status: 'completed' | 'cancelled' | 'expired'): void => {
      const url = new URL(shopperResultUrl, window.location.origin);
      url.searchParams.set('checkoutId', checkoutId);
      if (status !== 'completed') url.searchParams.set('status', status);
      window.location.href = url.toString();
    };

    // Inject checkout.js. Once loaded, initiate + render.
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = (): void => {
      const w = window as unknown as { Checkout?: CheckoutGlobal };
      if (!w.Checkout || typeof w.Checkout.initiate !== 'function') {
        console.error('[PeachWidget] Checkout global missing after script load');
        return;
      }
      try {
        const checkout = w.Checkout.initiate({
          key:        entityId,
          checkoutId,
          events: {
            onCompleted: () => navigateBack('completed'),
            onCancelled: () => navigateBack('cancelled'),
            onExpired:   () => navigateBack('expired'),
          },
        });
        checkout.render('#payment-form');
      } catch (err) {
        console.error('[PeachWidget] Checkout.initiate threw', err);
      }
    };
    script.onerror = (): void => {
      console.error('[PeachWidget] checkout.js failed to load');
    };
    document.body.appendChild(script);

    return () => {
      script.remove();
      // Best-effort cleanup — the embedded component attaches DOM to
      // #payment-form. If the caller re-mounts with a new checkoutId
      // React will unmount the container div first, so children go with
      // it. We also drop the global so a fresh mount doesn't reuse
      // stale state.
      try {
        const w = window as unknown as { Checkout?: unknown };
        delete w.Checkout;
      } catch { /* ignore */ }
    };
  }, [checkoutId, entityId, shopperResultUrl]);

  return (
    <div ref={containerRef} data-testid="peach-widget">
      <div id="payment-form" />
    </div>
  );
}
