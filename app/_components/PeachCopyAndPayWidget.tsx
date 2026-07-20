'use client';

import { useEffect, useRef } from 'react';

// ─── Peach COPYandPAY (paymentWidgets.js) mount — Flow B ONLY ───────
//
// This is the second door of our dual-door architecture (see
// lib/payments/peach/copyandpay/registration.ts for the full rationale).
// It renders Peach's OPPWA COPYandPAY widget in registration-only
// mode — minimal card form, no shopper email or billing fields, no
// amount displayed.
//
//   • Flow A (first-instalment CIT + future paying flows) uses the
//     newer PeachWidget (V2 embedded checkout) at
//     app/_components/PeachWidget.tsx — DO NOT reuse this component
//     for paying flows.
//
//   • Flow B (patient card-vault) uses THIS component. The server
//     creates a registration-only checkout via
//     createCardRegistration() and returns { checkoutId,
//     shopperResultUrl }; the widget navigates the browser to
//     shopperResultUrl?resourcePath=/v1/checkouts/{id}/registration
//     on completion (registration-only suffix; a paying checkout
//     would use /payment).
//
// Env vars:
//   • NEXT_PUBLIC_PEACH_WIDGET_URL — browser origin for
//     paymentWidgets.js (sandbox: https://sandbox-card.peachpayments.com,
//     production: confirm from Dashboard). This is NOT a secret —
//     the checkoutId is per-transaction and short-lived, and the
//     server-side Bearer token stays server-side.
//
// ─── What's stylable vs iframe-locked ───────────────────────────────
//
// paymentWidgets.js renders MOST of its DOM into our page (not into
// an iframe). Only the sensitive card-number/CVV inputs are wrapped
// in a Peach-hosted iframe (per PCI-DSS SAQ A scope). Everything
// else — brand row, labels, submit button, form container — is
// injected into our page and IS stylable via page CSS + wpwlOptions.
//
// Confirmed stylable via page-level CSS (rendered outside iframe):
//   • .wpwl-container         — form container
//   • .wpwl-brand-*           — brand chips row above the card fields
//   • .wpwl-label-*           — field labels ("Card number", "CVV" etc.)
//   • .wpwl-button-pay        — the submit button (colour, radius, text)
//   • .wpwl-group-*           — field-group wrappers (rows/columns)
//
// NOT stylable — iframe boundary (Peach-owned):
//   • The card-number and CVV INPUT boxes themselves (inner styling,
//     placeholder text). We can style the surrounding label + border
//     via wrapper class overrides but not the input's interior.
//   • Autofill highlight colour on the sensitive inputs.
//
// The button label is derived by paymentWidgets from the checkout's
// createRegistration + amount state; there is no documented
// wpwlOptions knob for a custom button label. For a registration-only
// checkout the default label is already "Pay" (no localised "Save
// card") — we override via CSS pseudo-content on the surrounding
// element rather than fighting the widget's own DOM writes.

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
    // Options chosen (all documented in the OPPWA COPYandPAY
    // advanced-options reference):
    //   • style: 'card' — single-line compact card form (name +
    //     card number + expiry + CVV on one row when wide enough,
    //     stacked on narrow). This is the closest built-in style
    //     to a clean "save card" sheet.
    //   • locale: 'en' — English strings for labels + validation.
    //   • brandDetection: true — auto-detects Visa/Mastercard from
    //     the BIN so we don't need a brand selector; combined with
    //     the CSS hide below this makes the top brand-chips row
    //     invisible while keeping detection working.
    //   • imageStyle: 'svg' — sharper brand icons where visible.
    //
    // Deliberately absent:
    //   • billingAddress / mandatoryBillingFields — Flow B is a
    //     vault, not a purchase; no address needed.
    //   • labels — Peach docs don't document a labels override for
    //     the button. We use page CSS instead (see below).
    //
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).wpwlOptions = {
      style:          'card',
      locale:         'en',
      brandDetection: true,
      imageStyle:     'svg',
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
    <div ref={containerRef} data-testid="peach-copyandpay-widget" className="peach-cnp-wrapper">
      {/* ── Brand overrides (rendered outside the payment iframe) ────
          Hides the brand-chips row at the top of the widget (the
          "dated" look), tightens spacing, and repaints the submit
          button in navy → teal (#13294B → #15A89E) to match the rest
          of the sheet. Rules target the classes paymentWidgets.js
          writes into our DOM; they DO NOT reach the sensitive-input
          iframes (Peach's own iframe contents are unstyled from
          here, which is expected under PCI SAQ A scope). */}
      <style>{`
        .peach-cnp-wrapper .wpwl-container {
          border: none;
          box-shadow: none;
          padding: 0;
          background: transparent;
        }
        .peach-cnp-wrapper .wpwl-form {
          padding: 0;
          margin: 0;
        }
        /* Hide the brand chips row — brandDetection still works from
           the BIN, so we don't need to expose the selector. */
        .peach-cnp-wrapper .wpwl-container-brand,
        .peach-cnp-wrapper .wpwl-brand-container,
        .peach-cnp-wrapper .wpwl-brand,
        .peach-cnp-wrapper .wpwl-brand-card {
          display: none !important;
        }
        /* Field labels — quieter, our type scale. */
        .peach-cnp-wrapper .wpwl-label,
        .peach-cnp-wrapper .wpwl-label-cardHolder,
        .peach-cnp-wrapper .wpwl-label-cardNumber,
        .peach-cnp-wrapper .wpwl-label-expiry,
        .peach-cnp-wrapper .wpwl-label-cvv {
          font-size: 12px;
          color: #6b7280;
          font-weight: 500;
          margin-bottom: 4px;
        }
        /* Field wrappers — rounded, subtle border. Peach's own
           input DIVs get this; the iframe inside them inherits
           height only. */
        .peach-cnp-wrapper .wpwl-control {
          border: 1px solid rgba(19, 41, 75, 0.15);
          border-radius: 8px;
          padding: 10px 12px;
          font-size: 14px;
          background: #fff;
        }
        .peach-cnp-wrapper .wpwl-control:focus,
        .peach-cnp-wrapper .wpwl-control-iframe:focus-within {
          border-color: #15A89E;
          box-shadow: 0 0 0 3px rgba(21, 168, 158, 0.15);
          outline: none;
        }
        /* Submit button — brand gradient, full-width, our button style. */
        .peach-cnp-wrapper .wpwl-button-pay {
          background: linear-gradient(135deg, #13294B 0%, #15A89E 145%);
          border: none;
          color: #fff;
          border-radius: 12px;
          padding: 12px 20px;
          font-weight: 600;
          font-size: 14px;
          width: 100%;
          margin-top: 8px;
          cursor: pointer;
          transition: box-shadow 0.15s ease;
        }
        .peach-cnp-wrapper .wpwl-button-pay:hover {
          box-shadow: 0 8px 16px rgba(19, 41, 75, 0.15);
        }
        .peach-cnp-wrapper .wpwl-button-pay[disabled] {
          opacity: 0.6;
          cursor: not-allowed;
        }
        /* Group / row spacing so the form feels like the rest of
           the sheet (single-column, tight). */
        .peach-cnp-wrapper .wpwl-group {
          margin-bottom: 12px;
        }
      `}</style>
      {/* The form's `class="paymentWidgets"` is what paymentWidgets.js
          hydrates. shopperResultUrl is where the widget navigates
          the browser on completion (server route reads the appended
          ?resourcePath=... to fetch final status). */}
      <form
        action={shopperResultUrl}
        className="paymentWidgets"
        data-brands={brands}
      />
    </div>
  );
}
