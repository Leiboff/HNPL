'use client';

import { useEffect, useRef } from 'react';

// ─── Peach COPYandPAY (paymentWidgets.js) mount — Flow B ONLY ───────
//
// Flow B (patient card-vault) only. Flow A uses the V2 embedded
// checkout widget at app/_components/PeachWidget.tsx — DO NOT reuse
// this component for paying flows.
//
// Registration-only completion: paymentWidgets navigates the browser
// to shopperResultUrl?resourcePath=/v1/checkouts/{id}/registration
// on success.
//
// Env vars:
//   NEXT_PUBLIC_PEACH_WIDGET_URL — browser origin for paymentWidgets.js
//     (sandbox: https://sandbox-card.peachpayments.com). Not a secret;
//     Bearer + entity id stay server-side.
//
// ─── What Peach's docs let us style (Step 0 report, task 2026-07-20) ─
//
// wpwlOptions (from oppwa-integrations-copyandpay-customisation):
//   style              'plain' | 'card'
//   locale             ISO code
//   brandDetection     true → widget infers brand from BIN. With NO
//                      data-brands attribute on the form, no manual
//                      selector renders at all.
//   iframeStyles       object; documented selectors are placeholders
//                      only: 'card-number-placeholder', 'cvv-placeholder'.
//                      Documented CSS: color, font-size, font-family
//                      (web-safe). We also set 'card-number' / 'cvv'
//                      as best-effort for typed-text — undocumented,
//                      degrades to no-op if the widget ignores them.
//   onReady            callback (unused here)
//   onChangeBrand      callback (unused here)
//
// Selectors NOT usable inside the iframe (all are page-CSS only):
//   .wpwl-container / .wpwl-form / .wpwl-group        — form structure
//   .wpwl-wrapper-brand / .wpwl-label-brand           — brand chip row
//   .wpwl-label / -cardNumber / -expiry / -cardHolder — labels
//   .wpwl-control / .wpwl-control-iframe              — input wrappers
//   .wpwl-button-pay                                  — submit button
//   .wpwl-has-error / .wpwl-hint-*Error               — validation
//
// Iframe boundary caveats (PCI SAQ A — Peach-owned):
//   • Placeholder TEXT strings are Peach-owned; we can only STYLE them.
//   • line-height / height inside the iframe are NOT documented as
//     settable, so we fix input clipping by sizing the OUTER
//     .wpwl-control-iframe wrapper (that resizes the iframe element
//     itself) + font-size in iframeStyles to keep the digits
//     comfortably inside.
//
// ─── Defect 1 (2026-07-20) — brand selector root cause ─────────────
//
// The prior mount set data-brands="VISA MASTER" on the form. When
// that attribute is present, paymentWidgets renders the "Brand:"
// dropdown regardless of brandDetection. The docs' registration-only
// example OMITS data-brands entirely — that's the correct config for
// automatic detection with NO manual selector. This file no longer
// takes a brands prop and no longer renders data-brands on the form.

type Props = {
  checkoutId:       string;
  shopperResultUrl: string;
};

// Registration-only iframe metrics — matches our onboarding input
// component (rounded-lg, py-2.5, text-sm) so the widget's card
// fields sit at the same visual weight as native betternow inputs.
const IFRAME_MIN_HEIGHT_PX = 44;
const IFRAME_FONT_SIZE_PX  = 14;
const IFRAME_FONT_FAMILY   =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const IFRAME_TEXT_COLOR        = '#111827';
const IFRAME_PLACEHOLDER_COLOR = '#9CA3AF';

export default function PeachCopyAndPayWidget({
  checkoutId,
  shopperResultUrl,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const widgetHost = process.env.NEXT_PUBLIC_PEACH_WIDGET_URL;
    if (!widgetHost) {
      console.error('[PeachCopyAndPayWidget] NEXT_PUBLIC_PEACH_WIDGET_URL is not set');
      return;
    }

    // wpwlOptions MUST be assigned before the script tag mounts, else
    // the widget picks up its own defaults. Object shape below is per
    // the Step 0 customisation-guide reference.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).wpwlOptions = {
      style:          'card',
      locale:         'en',
      // Automatic detection from BIN — with NO data-brands on the
      // form (see JSX below) the widget will NOT render a manual
      // selector. This is the exact combo the customisation-guide
      // registration example uses.
      brandDetection: true,
      // iframeStyles — inside-the-iframe styling of the sensitive
      // inputs. Placeholder selectors are docs-confirmed; typed-text
      // selectors ('card-number', 'cvv') are best-effort (silent
      // no-op if unsupported).
      iframeStyles: {
        'card-number-placeholder': {
          color:         IFRAME_PLACEHOLDER_COLOR,
          'font-size':   `${IFRAME_FONT_SIZE_PX}px`,
          'font-family': IFRAME_FONT_FAMILY,
        },
        'cvv-placeholder': {
          color:         IFRAME_PLACEHOLDER_COLOR,
          'font-size':   `${IFRAME_FONT_SIZE_PX}px`,
          'font-family': IFRAME_FONT_FAMILY,
        },
        'card-number': {
          color:         IFRAME_TEXT_COLOR,
          'font-size':   `${IFRAME_FONT_SIZE_PX}px`,
          'font-family': IFRAME_FONT_FAMILY,
        },
        'cvv': {
          color:         IFRAME_TEXT_COLOR,
          'font-size':   `${IFRAME_FONT_SIZE_PX}px`,
          'font-family': IFRAME_FONT_FAMILY,
        },
      },
    };

    const script       = document.createElement('script');
    script.src         = `${widgetHost.replace(/\/$/, '')}/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(checkoutId)}`;
    script.async       = true;
    script.crossOrigin = 'anonymous';
    document.body.appendChild(script);

    return () => {
      script.remove();
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
      {/* ── Outer form CSS ────────────────────────────────────────────
          Everything below targets DOM the widget writes into OUR page
          (not iframe content). Together with iframeStyles above this
          gets us as close to native betternow inputs as Peach permits.

          Layout:
            • Card number   — full-width row
            • Cardholder    — full-width row (rendered when field present)
            • Expiry + CVV  — side-by-side on ≥ 400px width
          Metrics match onboarding StepClient INPUT_CLS:
            rounded-lg  border  border-gray-300  px-3  py-2.5  text-sm
            focus:      border #15A89E, ring #15A89E/20
          Iframe wrappers get min-height so typed text is never clipped
          (Peach doesn't expose height inside the iframe — outer sizing
          is the only lever).
      */}
      <style>{`
        .peach-cnp-wrapper .wpwl-container,
        .peach-cnp-wrapper .wpwl-form,
        .peach-cnp-wrapper .wpwl-form-card {
          border: none !important;
          box-shadow: none !important;
          background: transparent !important;
          padding: 0 !important;
          margin: 0 !important;
          max-width: 100%;
        }
        /* Belt-and-braces brand-selector suppression (docs recipe).
           With no data-brands on the form these should not render at
           all — but the CSS ensures no visual artefact if a future
           widget-script build changes the default. */
        .peach-cnp-wrapper .wpwl-wrapper-brand,
        .peach-cnp-wrapper .wpwl-label-brand,
        .peach-cnp-wrapper .wpwl-group-brand,
        .peach-cnp-wrapper .wpwl-brand-container {
          display: none !important;
        }

        /* Labels — quiet, our type scale. */
        .peach-cnp-wrapper .wpwl-label,
        .peach-cnp-wrapper .wpwl-label-cardHolder,
        .peach-cnp-wrapper .wpwl-label-cardNumber,
        .peach-cnp-wrapper .wpwl-label-expiry,
        .peach-cnp-wrapper .wpwl-label-cvv {
          font-size: 12px !important;
          color: #6b7280 !important;
          font-weight: 500 !important;
          margin-bottom: 4px !important;
          display: block !important;
        }

        /* Input wrappers — matches INPUT_CLS metrics. */
        .peach-cnp-wrapper .wpwl-control,
        .peach-cnp-wrapper .wpwl-wrapper input.wpwl-control,
        .peach-cnp-wrapper .wpwl-control-iframe {
          width: 100% !important;
          border: 1px solid #d1d5db !important;
          border-radius: 8px !important;
          background: #fff !important;
          font-size: 14px !important;
          color: #111827 !important;
          box-shadow: none !important;
        }
        /* Non-iframe inputs (cardholder, expiry) — inner padding. */
        .peach-cnp-wrapper .wpwl-control:not(.wpwl-control-iframe) {
          padding: 10px 12px !important;
          height: ${IFRAME_MIN_HEIGHT_PX}px !important;
          line-height: 20px !important;
        }
        /* IFRAME wrappers — Peach's iframe fills this element. Give
           it explicit min-height so typed digits never clip. Padding
           lives inside the iframe (docs don't let us set padding
           there), so we accept that the iframe interior may sit
           slightly higher than an outer input — the height match
           keeps them the same overall size. */
        .peach-cnp-wrapper .wpwl-control-iframe {
          min-height: ${IFRAME_MIN_HEIGHT_PX}px !important;
          padding: 0 !important;
          overflow: hidden;
        }
        .peach-cnp-wrapper .wpwl-control-iframe iframe {
          width: 100% !important;
          height: ${IFRAME_MIN_HEIGHT_PX}px !important;
          border: 0 !important;
          display: block;
        }
        /* Focus ring — matches native input focus in onboarding. */
        .peach-cnp-wrapper .wpwl-control:focus,
        .peach-cnp-wrapper .wpwl-control.wpwl-focus,
        .peach-cnp-wrapper .wpwl-control-iframe.wpwl-focus {
          border-color: #15A89E !important;
          outline: none !important;
          box-shadow: 0 0 0 3px rgba(21, 168, 158, 0.20) !important;
        }
        /* Validation — subdued red border, our palette. */
        .peach-cnp-wrapper .wpwl-has-error .wpwl-control,
        .peach-cnp-wrapper .wpwl-has-error .wpwl-control-iframe {
          border-color: #dc2626 !important;
          box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.15) !important;
        }
        .peach-cnp-wrapper .wpwl-hint {
          color: #dc2626 !important;
          font-size: 12px !important;
          margin-top: 4px !important;
        }

        /* Groups — vertical rhythm. */
        .peach-cnp-wrapper .wpwl-group {
          margin: 0 0 12px 0 !important;
          padding: 0 !important;
        }
        /* Expiry + CVV side-by-side above 400px; stacked below. Peach
           renders them as separate .wpwl-group-expiry / .wpwl-group-cvv;
           flex on the shared parent .wpwl-form gives us a 2-col row. */
        @media (min-width: 400px) {
          .peach-cnp-wrapper .wpwl-form {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
          }
          .peach-cnp-wrapper .wpwl-group {
            flex: 1 1 100%;
            min-width: 0;
          }
          .peach-cnp-wrapper .wpwl-group-expiry,
          .peach-cnp-wrapper .wpwl-group-cvv {
            flex: 1 1 calc(50% - 6px);
          }
          .peach-cnp-wrapper .wpwl-group-submit {
            flex: 1 1 100%;
            margin-top: 4px !important;
          }
        }

        /* Submit button — navy → teal gradient, full-width. */
        .peach-cnp-wrapper .wpwl-button-pay {
          background: linear-gradient(135deg, #13294B 0%, #15A89E 145%) !important;
          border: none !important;
          color: #fff !important;
          border-radius: 12px !important;
          padding: 12px 20px !important;
          font-weight: 600 !important;
          font-size: 14px !important;
          width: 100% !important;
          cursor: pointer;
          transition: box-shadow 0.15s ease, transform 0.15s ease;
        }
        .peach-cnp-wrapper .wpwl-button-pay:hover:not([disabled]) {
          box-shadow: 0 8px 16px rgba(19, 41, 75, 0.15);
        }
        .peach-cnp-wrapper .wpwl-button-pay[disabled] {
          opacity: 0.6;
          cursor: not-allowed;
        }
      `}</style>
      {/* No data-brands attribute — that's what triggers automatic
          BIN-based detection with NO manual selector rendered
          (docs-confirmed recipe). */}
      <form
        action={shopperResultUrl}
        className="paymentWidgets"
      />
    </div>
  );
}
