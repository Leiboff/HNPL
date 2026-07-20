// SERVER-ONLY. Never import in a client component.
//
// ─── Peach COPYandPAY registration-only vault ───────────────────────
//
// This module is the "second door" of a DUAL-DOOR architecture:
//
//   Door 1 — CHECKOUT V2 EMBEDDED (Flow A, Flow C-adjacent)
//     • Used for PAYING flows: Flow A first-instalment CIT and any
//       future customer-present debits.
//     • Purchase-shaped UI: shopper email / billing fields, button
//       labelled "Pay now" — accurate when money is changing hands.
//     • Lives in lib/payments/peach/client.ts (createCheckout + friends).
//
//   Door 2 — COPYandPAY REGISTRATION-ONLY (Flow B, THIS FILE)
//     • Used for the card-vault screen ONLY. No debit, no capture,
//       no PA hold — the widget simply tokenises a card and returns
//       a registrationId.
//     • Vault-shaped UI: minimal card form, button labelled
//       "Save card" — accurate when no money moves.
//     • Runs the legacy OPPWA COPYandPAY widget (paymentWidgets.js);
//       this is the SAME product family as our recurring MIT surface,
//       so it reuses PEACH_RECURRING_ENTITY_ID +
//       PEACH_RECURRING_ACCESS_TOKEN + the recurring host. No new
//       credentials required.
//
// Why the dual door instead of unifying on V2:
//   Embedded Checkout V2 does NOT provide a first-class "verify only"
//   mode. A zero-amount PA can be forced through, but the widget
//   still renders as a purchase form (button reads "Pay now", email
//   is collected as a shopper field). Card-add is a vault action, not
//   a purchase — misrepresenting it as a payment is a trust regression
//   in the sheet. Competitor evidence (ZeroPay) runs this exact split
//   on the same Peach account.
//
// Both doors mint registrationIds into the SAME payment_methods table
// via the same saveCardForPatient dedupe path; downstream MIT charges
// (Flow C) don't care which door produced the token.
//
// Chain-root note (peach_initial_transaction_id):
//   COPYandPAY registration-only creates NO initial transaction —
//   there is nothing to reference as an initialTransactionId. Plans
//   that go on to use such a card MUST send their first MIT charge
//   under standingInstruction.type=UNSCHEDULED without an
//   initialTransactionId. Both chargeInstalment.ts and settle-actions.ts
//   already implement that fallback when plans.peach_initial_transaction_id
//   is null.

import crypto from 'node:crypto';
import { classifyResultCode } from '../resultCodes';
import type { PaymentStatus } from '../../provider';

// ─── Env-driven configuration (recurring family + widget host) ──────
//
// COPYandPAY is same-product-family as the recurring MIT surface;
// reuse those creds + host. NEXT_PUBLIC_PEACH_WIDGET_URL is the
// browser-visible origin of paymentWidgets.js (same host as
// PEACH_RECURRING_URL) — needed because the widget script has to be
// fetched cross-origin from the recurring host, so the browser needs
// to know the URL. It's not a secret; the sensitive material stays
// on the server (Bearer token + entity id).

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in environment variables.`);
  return v;
}

function trimSlash(u: string): string { return u.replace(/\/$/, ''); }

function recurringUrl():    string { return trimSlash(requireEnv('PEACH_RECURRING_URL')); }
function recurringEntity(): string { return requireEnv('PEACH_RECURRING_ENTITY_ID'); }
function recurringToken():  string { return requireEnv('PEACH_RECURRING_ACCESS_TOKEN'); }

const DEFAULT_TIMEOUT_MS = 8_000;

// ─── Transport (Bearer + form-encoded, scoped to recurring host) ────
//
// Small intentional duplicate of client.ts:recurringFetch. Two
// reasons for keeping it here rather than importing:
//
//   1. Keeps this module a true seam — client.ts and copyandpay/
//      registration.ts have zero cross-imports beyond the shared
//      PaymentStatus type + resultCodes classifier.
//   2. Isolates a possible future divergence — COPYandPAY may need
//      different timeouts / error handling than the MIT surface once
//      we see real sandbox traffic.
//
// If either module later grows a third variant, promote to a shared
// _transport.ts module.

async function copyAndPayFetch(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${recurringUrl()}${path}`;
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${recurringToken()}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      // Prominent, greppable log — the /v1/checkouts create call has
      // no other way to surface the exact field Peach rejected.
      console.error('PEACH COPYANDPAY ERROR:', {
        method,
        path,
        status:     res.status,
        statusText: res.statusText,
        bodyText:   text,
        parsedBody: parsed,
      });
      const msg = (parsed as { result?: { description?: string } } | null)?.result?.description
        ?? `HTTP ${res.status} ${res.statusText}`;
      const err = new Error(`Peach COPYandPAY error: ${msg}`);
      (err as Error & { raw?: unknown }).raw = parsed;
      throw err;
    }
    return parsed;
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new Error(`Peach COPYandPAY timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Form-body helpers ─────────────────────────────────────────────

function toFormBody(obj: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const inner = toFormBody(v as Record<string, unknown>, key);
      if (inner) parts.push(inner);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join('&');
}

function toCustomParametersBody(params: Record<string, string> | undefined): string {
  if (!params) return '';
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(`customParameters[${k}]`)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ─── Response typing ────────────────────────────────────────────────

type PeachResult = { code?: string; description?: string };

type PeachCard = {
  bin?:          string;
  last4Digits?:  string;
  holder?:       string;
  expiryMonth?:  string;
  expiryYear?:   string;
  paymentBrand?: string;
  binCountry?:   string;
};

type PeachRegistrationBody = {
  id?:                    string;
  merchantTransactionId?: string;
  amount?:                string;
  result?:                PeachResult;
  card?:                  PeachCard;
  registrationId?:        string;
  paymentBrand?:          string;
  paymentType?:           string;
  customParameters?:      Record<string, string>;
};

type CheckoutCreateResponse = {
  id?:       string;
  result?:   PeachResult;
};

// ─── Registration-id extraction — the load-bearing bit ─────────────
//
// Peach OPPWA returns TWO different response shapes on the checkout-
// status GET, both with a top-level `id`:
//
//   Payment-with-createRegistration (Flow A never uses this door):
//     { id: "<payment-transaction-id>",
//       registrationId: "<reusable-token>", ...amount, currency }
//     → the token lives under `registrationId`.
//
//   Registration-only (Flow B — this file):
//     { id: "<reusable-token>",
//       paymentBrand, result, card, customer, ... }   // NO `registrationId`
//     → per the Peach registration-tokens reference, the top-level
//       `id` IS the reusable token; there is no separate
//       `registrationId` field.
//
// Reading only `body.registrationId` (as we did originally) silently
// returned undefined on every successful vault, which flowed through
// the return route as "Peach didn't return a stored registration" →
// FailureCard → user clicks "Try again" → same resourcePath → same
// failure. That's the loop the users saw.
//
// Rule of thumb: prefer `registrationId` when Peach gave us both
// (payment case, defensive — we don't own that call today but keep
// the codepath honest); fall back to `id` when it's absent AND the
// response looks registration-shaped (has a card, no amount).
function pickRegistrationId(body: PeachRegistrationBody): string | undefined {
  if (body.registrationId) return body.registrationId;
  const looksLikeRegistrationOnly = body.card !== undefined && !body.amount;
  if (looksLikeRegistrationOnly && body.id) return body.id;
  return undefined;
}

function toPaymentStatus(body: PeachRegistrationBody): PaymentStatus {
  const code           = body.result?.code;
  const registrationId = pickRegistrationId(body);
  return {
    status:                classifyResultCode(code),
    // On a registration-only response `id` IS the registrationId, so
    // exposing it under `providerPaymentId` would be misleading —
    // there's no separate transaction to look up. When we picked `id`
    // as the registration token, leave providerPaymentId undefined.
    providerPaymentId:     body.registrationId ? body.id : undefined,
    merchantTransactionId: body.merchantTransactionId,
    resultCode:            code,
    resultDescription:     body.result?.description,
    registrationId,
    card: body.card ? {
      // paymentBrand can live on the card OR at the top level in Peach
      // responses; the top-level copy is what the registration-only
      // reference documents. Prefer whichever is present.
      brand:       body.card.paymentBrand ?? body.paymentBrand ?? null,
      last4:       body.card.last4Digits  ?? null,
      expiryMonth: body.card.expiryMonth  ? Number(body.card.expiryMonth) : null,
      expiryYear:  body.card.expiryYear   ? Number(body.card.expiryYear)  : null,
      holder:      body.card.holder       ?? null,
      binCountry:  body.card.binCountry   ?? null,
    } : undefined,
    raw: body,
  };
}

// ─── Public API ────────────────────────────────────────────────────

export type CardRegistrationCreateParams = {
  merchantTransactionId: string;   // Must be 1-16 chars — use mintPeachRef('r', ...).
  customer?: {
    email?:     string | null;
    givenName?: string | null;
    surname?:   string | null;
  };
  customParameters?: Record<string, string>;
};

export type CardRegistrationCreated = {
  checkoutId: string;
  raw?:       unknown;
};

/**
 * Create a COPYandPAY registration-only checkout.
 *
 * Params sent (verified against Peach docs + our own working
 * pre-pivot implementation on master):
 *   entityId              = PEACH_RECURRING_ENTITY_ID  (same product family)
 *   merchantTransactionId = compact 16-char ref (purpose 'r')
 *   createRegistration    = 'true'
 *   customer.*            = optional (email / givenName / surname)
 *   customParameters[…]   = optional (we send SHOPPER_patientId +
 *                                     SHOPPER_purpose='card_registration')
 *
 * NOT sent (deliberately absent — the docs specify that omitting
 * these together indicates a registration-only shape):
 *   amount, currency, paymentType, standingInstruction
 *
 * A pure vault has no scheme "standing instruction" until an initial
 * CIT/MIT actually charges — sending standingInstruction fields on a
 * zero-charge registration would be a schema mismatch. The first MIT
 * charge on any plan using this card falls back to
 * type=UNSCHEDULED (see chargeInstalment.ts + settle-actions.ts).
 */
export async function createCardRegistration(
  params: CardRegistrationCreateParams,
): Promise<CardRegistrationCreated> {
  // 16-char limit belt-and-braces — mintPeachRef already produces
  // compliant refs, but a caller regression here would otherwise
  // silently fail at the Peach edge.
  if (!params.merchantTransactionId || params.merchantTransactionId.length > 16) {
    throw new Error(
      `createCardRegistration: merchantTransactionId must be 1-16 chars; got ${params.merchantTransactionId?.length ?? 0} ("${params.merchantTransactionId}")`,
    );
  }

  const form: Record<string, unknown> = {
    entityId:              recurringEntity(),
    merchantTransactionId: params.merchantTransactionId,
    createRegistration:    'true',
  };
  if (params.customer) form.customer = { ...params.customer };

  const flat  = toFormBody(form);
  const extra = toCustomParametersBody(params.customParameters);
  const body  = extra ? `${flat}&${extra}` : flat;

  const res = await copyAndPayFetch('POST', '/v1/checkouts', body) as CheckoutCreateResponse;
  if (!res?.id) throw new Error('createCardRegistration: response missing checkout id');
  return { checkoutId: res.id, raw: res };
}

/**
 * Fetch the status of a COPYandPAY checkout after the widget returns.
 *
 * Peach appends the resourcePath onto the shopperResultUrl. Two
 * distinct suffixes, one per shape:
 *   • REGISTRATION-ONLY (Flow B — this door):
 *       ?resourcePath=/v1/checkouts/{id}/registration
 *     Response shape has TOP-LEVEL `id` = the reusable token,
 *     `paymentBrand`, `result`, `card`, `customer`, `customParameters`,
 *     `risk`, `buildNumber`, `timestamp`, `ndc` — with NO separate
 *     `registrationId` field. (Docs: oppwa-integrations-copyandpay-
 *     registration-tokens.)
 *   • PAYMENT (with or without createRegistration):
 *       ?resourcePath=/v1/checkouts/{id}/payment
 *     Response carries transaction `id`, plus `registrationId` when
 *     createRegistration was requested.
 *
 * We forward whichever suffix the widget hands us — the Peach GET
 * accepts both — and lean on pickRegistrationId() to normalise.
 *
 * The raw response is logged under "PEACH REG STATUS RESPONSE:" so
 * any future shape drift shows up in the logs directly.
 */
export async function getCardRegistrationStatus(resourcePath: string): Promise<PaymentStatus> {
  const normalisedPath = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
  const sep  = normalisedPath.includes('?') ? '&' : '?';
  const path = `${normalisedPath}${sep}entityId=${encodeURIComponent(recurringEntity())}`;
  const res  = await copyAndPayFetch('GET', path) as PeachRegistrationBody;
  const parsed = toPaymentStatus(res);
  console.log('PEACH REG STATUS RESPONSE:', {
    resourcePath,
    resolvedRegistrationId: parsed.registrationId,
    resultCode:             parsed.resultCode,
    body:                   res,
  });
  return parsed;
}

// Exported for tests only.
export const __internals = { toFormBody, toCustomParametersBody, toPaymentStatus, pickRegistrationId };
// Nod to crypto so a linter doesn't strip the import; used by callers
// via crypto.randomUUID passed into mintPeachRef seeds.
void crypto;
