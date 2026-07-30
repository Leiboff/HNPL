// SERVER-ONLY. Never import this file in a client component.
//
// Peach Checkout V2 (CIT) + recurring card-on-file (MIT) client.
// Replaces the legacy COPYandPAY / OPPWA single-Bearer + entityId model
// with the recommended two-surface architecture:
//
//   • Checkout V2 surface — OAuth-authed. Used by:
//       - createCheckout()       — POST /v2/checkout
//       - getCheckoutStatus()    — GET  /v2/checkout/{id}/status
//     Token fetched from PEACH_AUTH_URL /api/oauth/token with
//       { clientId, clientSecret, merchantId }
//     Cached in-process until 30s before expiry.
//
//   • Recurring surface — static Bearer PEACH_RECURRING_ACCESS_TOKEN.
//     Used by:
//       - chargeSavedCard()      — POST /v1/registrations/{id}/payments
//       - deleteRegistration()   — DELETE /v1/registrations/{id}
//       - refund()               — POST /v1/payments/{id}
//     entityId on every request = PEACH_RECURRING_ENTITY_ID.
//
// Env vars (all server-side; the NEXT_PUBLIC_ ones are widget-only):
//
//   Checkout V2 (Dashboard → Checkout):
//     PEACH_CHECKOUT_CLIENT_ID       OAuth client id
//     PEACH_CHECKOUT_CLIENT_SECRET   OAuth client secret
//     PEACH_CHECKOUT_MERCHANT_ID     Merchant id (OAuth body)
//     PEACH_CHECKOUT_ENTITY_ID       `key` passed to checkout.js in the browser
//     PEACH_CHECKOUT_SECRET_TOKEN    HMAC key for verifying Checkout webhooks
//     PEACH_AUTH_URL                 Auth service base — TODO(dina): confirm from Dashboard
//     PEACH_CHECKOUT_URL             Checkout API base — TODO(dina): confirm from Dashboard
//     NEXT_PUBLIC_PEACH_CHECKOUT_JS  Browser script (sandbox:
//                                    https://sandbox-checkout.peachpayments.com/js/checkout.js)
//
//   Recurring (Dashboard → Recurring payments):
//     PEACH_RECURRING_ENTITY_ID      Recurring entity id
//     PEACH_RECURRING_ACCESS_TOKEN   Bearer token for recurring calls
//     PEACH_RECURRING_URL            Card / recurring host base —
//                                    TODO(dina): confirm from Dashboard,
//                                    do not hardcode oppwa.com

import type {
  PaymentProvider,
  ChargeSavedCardParams,
  ChargeResult,
  CheckoutCreateParams,
  CheckoutCreated,
  CardRegistrationCreateParams,
  CardRegistrationCreated,
  PaymentStatus,
  RefundResult,
} from '../provider';
import { classifyResultCode } from './resultCodes';
import {
  createCardRegistration     as copyAndPayCreate,
  getCardRegistrationStatus  as copyAndPayStatus,
} from './copyandpay/registration';

// ─── Env helpers ────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in environment variables.`);
  return v;
}

function trimSlash(u: string): string { return u.replace(/\/$/, ''); }

function authUrl():         string { return trimSlash(requireEnv('PEACH_AUTH_URL')); }
function checkoutUrl():     string { return trimSlash(requireEnv('PEACH_CHECKOUT_URL')); }
function recurringUrl():    string { return trimSlash(requireEnv('PEACH_RECURRING_URL')); }
function checkoutEntity():  string { return requireEnv('PEACH_CHECKOUT_ENTITY_ID'); }
function recurringEntity(): string { return requireEnv('PEACH_RECURRING_ENTITY_ID'); }
function recurringToken():  string { return requireEnv('PEACH_RECURRING_ACCESS_TOKEN'); }
function checkoutClientId():     string { return requireEnv('PEACH_CHECKOUT_CLIENT_ID'); }
function checkoutClientSecret(): string { return requireEnv('PEACH_CHECKOUT_CLIENT_SECRET'); }
function checkoutMerchantId():   string { return requireEnv('PEACH_CHECKOUT_MERCHANT_ID'); }

// Hard cap on Peach call duration. Vercel Hobby functions time out at
// 10s; we leave a couple of seconds of headroom.
const DEFAULT_TIMEOUT_MS = 8_000;

// ─── OAuth token cache (Checkout V2) ────────────────────────────────

type CachedToken = { accessToken: string; expiresAt: number };
let cachedCheckoutToken: CachedToken | null = null;

async function fetchCheckoutAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedCheckoutToken && cachedCheckoutToken.expiresAt > now + 30_000) {
    return cachedCheckoutToken.accessToken;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${authUrl()}/api/oauth/token`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept:         'application/json',
      },
      body: JSON.stringify({
        clientId:     checkoutClientId(),
        clientSecret: checkoutClientSecret(),
        merchantId:   checkoutMerchantId(),
      }),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      const msg = (parsed as { error?: string; message?: string } | null)?.error
        ?? (parsed as { error?: string; message?: string } | null)?.message
        ?? `HTTP ${res.status} ${res.statusText}`;
      const err = new Error(`Peach auth error: ${msg}`);
      (err as Error & { raw?: unknown }).raw = parsed;
      throw err;
    }
    const body = parsed as { access_token?: string; expires_in?: number } | null;
    if (!body?.access_token) {
      throw new Error('Peach auth error: response missing access_token');
    }
    const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0
      ? body.expires_in
      : 300; // 5-min safety default if the field is missing
    cachedCheckoutToken = {
      accessToken: body.access_token,
      expiresAt:   now + (expiresIn * 1000),
    };
    return body.access_token;
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new Error(`Peach auth timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Test hook — resets the OAuth cache. Never call this in production code.
export function __resetPeachTokenCache(): void {
  cachedCheckoutToken = null;
}

// ─── Utility helpers ────────────────────────────────────────────────

// Rands → 2-decimal string for the Peach `amount` field. Every caller
// hands us integer cents; the string is what Peach wants on the wire.
export function formatAmountCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`Peach amount must be a non-negative integer cents value; got ${cents}`);
  }
  const rands = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `${rands}.${remainder.toString().padStart(2, '0')}`;
}

// Flatten nested objects with dot-notation. Used for the recurring
// endpoints which take application/x-www-form-urlencoded bodies.
export function toFormBody(obj: Record<string, unknown>, prefix = ''): string {
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

// Flatten customParameters — Peach spells these customParameters[NAME]=value.
function toCustomParametersBody(params: Record<string, string> | undefined): string {
  if (!params) return '';
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(`customParameters[${k}]`)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ─── Recurring surface fetcher (static Bearer, form-encoded) ────────

async function recurringFetch(
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
      const msg = (parsed as { result?: { description?: string } } | null)?.result?.description
        ?? `HTTP ${res.status} ${res.statusText}`;
      const err = new Error(`Peach error: ${msg}`);
      (err as Error & { raw?: unknown }).raw = parsed;
      throw err;
    }
    return parsed;
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new Error(`Peach timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Checkout V2 surface fetcher (OAuth, JSON) ──────────────────────

async function checkoutFetch(
  method: 'GET' | 'POST',
  path: string,
  jsonBody?: unknown,
  extraHeaders: Record<string, string> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const accessToken = await fetchCheckoutAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${checkoutUrl()}${path}`;
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept:        'application/json',
        ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      // Prominent, greppable log for the initiate path — otherwise a
      // 400 "Invalid request body" from Peach V2 lands as a generic
      // Error message with no context on WHICH field they rejected.
      const initiatePrefix = path === '/v2/checkout'
        ? 'PEACH CHECKOUT INITIATE ERROR:'
        : `PEACH CHECKOUT ERROR at ${path}:`;
      console.error(initiatePrefix, {
        status:     res.status,
        statusText: res.statusText,
        bodyText:   text,
        parsedBody: parsed,
      });
      const msg = (parsed as { result?: { description?: string }; message?: string } | null)?.result?.description
        ?? (parsed as { message?: string } | null)?.message
        ?? `HTTP ${res.status} ${res.statusText}`;
      const err = new Error(`Peach checkout error: ${msg}`);
      (err as Error & { raw?: unknown }).raw = parsed;
      throw err;
    }
    return parsed;
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new Error(`Peach checkout timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Response typing ────────────────────────────────────────────────

type PeachResult = {
  code?:        string;
  description?: string;
};

type PeachCard = {
  bin?:          string;
  last4Digits?:  string;
  holder?:       string;
  expiryMonth?:  string;
  expiryYear?:   string;
  paymentBrand?: string;
  binCountry?:   string;
};

type PeachPaymentBody = {
  id?:                    string;
  merchantTransactionId?: string;
  amount?:                string;
  currency?:              string;
  result?:                PeachResult;
  card?:                  PeachCard;
  registrationId?:        string;
  // On a REPEATED/MIT response, Peach echoes the root of the stored-
  // credential chain here — the id of the INITIAL/CIT transaction that
  // established the credential. This is the value we thread on
  // subsequent MIT charges as standingInstruction.initialTransactionId.
  // It is NOT the same as the response's own top-level `id`.
  //
  // TODO(dina): confirm in sandbox which exact field Peach returns as
  // the valid initialTransactionId (plain `id` vs a connector-specific
  // transaction id), and whether payWithSavedCard should be
  // REPEATED/CIT (customer present — may need 3DS) rather than
  // REPEATED/MIT. Not changing tagging in this pass — this note flags.
  standingInstruction?: {
    initialTransactionId?: string;
  };
};

// V2 status response is broadly the same shape as OPPWA payments —
// `id`, `merchantTransactionId`, `amount`, `result.code`, `card` etc.
// We fold it through the same normaliser.

function nonce(): string {
  // 32 random hex chars — Peach requires a unique nonce per checkout.
  // crypto.randomUUID gives us 128 bits of entropy; the dashes are
  // stripped so the string is dense.
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

function toPaymentStatus(body: PeachPaymentBody): PaymentStatus {
  const code = body.result?.code;
  return {
    status:                classifyResultCode(code),
    providerPaymentId:     body.id,
    merchantTransactionId: body.merchantTransactionId,
    amountCents:           body.amount ? Math.round(Number(body.amount) * 100) : undefined,
    resultCode:            code,
    resultDescription:     body.result?.description,
    registrationId:        body.registrationId,
    card: body.card ? {
      brand:       body.card.paymentBrand ?? null,
      last4:       body.card.last4Digits  ?? null,
      expiryMonth: body.card.expiryMonth  ? Number(body.card.expiryMonth) : null,
      expiryYear:  body.card.expiryYear   ? Number(body.card.expiryYear)  : null,
      holder:      body.card.holder       ?? null,
      binCountry:  body.card.binCountry   ?? null,
    } : undefined,
    raw: body,
  };
}

// ─── Provider implementation ────────────────────────────────────────

export class PeachProvider implements PaymentProvider {
  async createCheckout(params: CheckoutCreateParams): Promise<CheckoutCreated> {
    // Peach V2 hard limit: merchantTransactionId ≤ 16 chars (Visa /
    // Mastercard 3DS2 mandate; violation returns 800.100.156). Enforce
    // at the boundary so a regression in a caller's ref-generator
    // can't slip through.
    if (!params.merchantTransactionId || params.merchantTransactionId.length > 16) {
      throw new Error(
        `Peach createCheckout: merchantTransactionId must be 1-16 chars; got ${params.merchantTransactionId?.length ?? 0} (\"${params.merchantTransactionId}\")`,
      );
    }

    // V2 = purchase-shaped door only. Card-vault flows go through the
    // separate COPYandPAY door (see provider.createCardRegistration
    // + lib/payments/peach/copyandpay/registration.ts). Reject
    // amount=0 here to keep the dual-door invariant honest — a
    // regression that tries to route a vault through V2 fails loud
    // instead of silently reaching Peach.
    if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
      throw new Error(`Peach createCheckout: amountCents must be a positive integer (V2 is purchase-only; card vault → provider.createCardRegistration); got ${params.amountCents}`);
    }

    const origin = params.origin ?? process.env.NEXT_PUBLIC_APP_URL ?? '';

    // V2 JSON body shape — the exact field paths (`authentication.entityId`,
    // `standingInstruction.*`) come from the Checkout V2 request builder.
    const body: Record<string, unknown> = {
      authentication:        { entityId: checkoutEntity() },
      merchantTransactionId: params.merchantTransactionId,
      nonce:                 nonce(),
      amount:                formatAmountCents(params.amountCents),
      currency:              params.currency    ?? 'ZAR',
      paymentType:           params.paymentType ?? 'DB',
    };

    if (params.createRegistration) body.createRegistration = true;

    if (params.shopperResultUrl) body.shopperResultUrl = params.shopperResultUrl;

    if (params.standingInstruction) {
      // Whitelist the fields we forward to Peach V2 — the V2 validator
      // rejects unknown fields with "unknown field" errors. V2's SI
      // schema (developer.peachpayments.com/reference/post_v2-checkout)
      // is DELIBERATELY narrower than the OPPWA/recurring one:
      //
      //   V2 accepts:   mode, type, expiry, frequency,
      //                 numberOfInstallments, recurringType,
      //                 industryPractice.
      //   V2 rejects:   source (CIT/MIT) — OPPWA vocabulary.
      //                 initialTransactionId — OPPWA vocabulary.
      //
      // Those two fields ARE valid on the recurring /v1/registrations
      // path (see chargeSavedCard below), which uses the same-named
      // param on ChargeSavedCardParams and is untouched. Keeping the
      // filter explicit means a caller can still hand us OPPWA-shaped
      // SI without breaking V2 — the client scrubs the OPPWA-only
      // fields at the boundary.
      const src = params.standingInstruction;
      const si: Record<string, unknown> = {
        mode: src.mode,
        type: src.type,
      };
      if (src.expiry)               si.expiry               = src.expiry;
      if (typeof src.frequency === 'number')            si.frequency            = src.frequency;
      if (typeof src.numberOfInstallments === 'number') si.numberOfInstallments = src.numberOfInstallments;
      if (src.recurringType)        si.recurringType        = src.recurringType;
      if (src.industryPractice)     si.industryPractice     = src.industryPractice;
      body.standingInstruction = si;
    }

    if (params.customer) body.customer = { ...params.customer };

    if (params.customParameters) {
      // V2 accepts a `customParameters` object directly (JSON), unlike
      // OPPWA v1's bracket-form. Send as-is.
      body.customParameters = { ...params.customParameters };
    }

    const res = await checkoutFetch(
      'POST',
      '/v2/checkout',
      body,
      origin ? { Origin: origin } : {},
    ) as { checkoutId?: string; id?: string; result?: PeachResult };

    // V2 returns { checkoutId, result } in the primary shape; some
    // sandbox response bodies use `id` as a synonym. Accept either.
    const checkoutId = res?.checkoutId ?? res?.id;
    if (!checkoutId) throw new Error('Peach createCheckout: response missing checkoutId');
    return { checkoutId, raw: res };
  }

  async getCheckoutStatus(checkoutId: string): Promise<PaymentStatus> {
    // V2 status endpoint takes the checkoutId directly.
    // TODO(dina): confirm the exact status path in the Dashboard docs.
    // Current pattern: GET /v2/checkout/{id}/status. If the docs show
    // a different suffix (e.g. /result), swap here — the response body
    // shape is stable.
    const res = await checkoutFetch(
      'GET',
      `/v2/checkout/${encodeURIComponent(checkoutId)}/status`,
    ) as PeachPaymentBody;
    return toPaymentStatus(res);
  }

  async chargeSavedCard(params: ChargeSavedCardParams): Promise<ChargeResult> {
    if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
      throw new Error(`Peach chargeSavedCard: amountCents must be a positive integer; got ${params.amountCents}`);
    }
    // Same 16-char merchantTransactionId limit on the recurring
    // endpoint — Visa/Mastercard 3DS2 mandate applies acquirer-wide.
    if (!params.merchantTransactionId || params.merchantTransactionId.length > 16) {
      throw new Error(
        `Peach chargeSavedCard: merchantTransactionId must be 1-16 chars; got ${params.merchantTransactionId?.length ?? 0} (\"${params.merchantTransactionId}\")`,
      );
    }
    // MIT charges ALWAYS use the recurring credential set — never the
    // Checkout OAuth token. The entity is the recurring entity.
    const form: Record<string, unknown> = {
      entityId:              recurringEntity(),
      amount:                formatAmountCents(params.amountCents),
      currency:              params.currency ?? 'ZAR',
      paymentType:           'DB',
      merchantTransactionId: params.merchantTransactionId,
      standingInstruction:   { ...params.standingInstruction },
    };
    const body = toFormBody(form);
    let res: PeachPaymentBody;
    try {
      res = await recurringFetch(
        'POST',
        `/v1/registrations/${encodeURIComponent(params.registrationId)}/payments`,
        body,
      ) as PeachPaymentBody;
    } catch (err) {
      return {
        status:            'error',
        resultCode:        undefined,
        resultDescription: err instanceof Error ? err.message : String(err),
        raw:               (err as { raw?: unknown } | undefined)?.raw,
      };
    }
    return {
      status:               classifyResultCode(res.result?.code),
      providerPaymentId:    res.id,
      // Echoed root — see PeachPaymentBody.standingInstruction comment
      // above. Undefined if Peach didn't echo it; the caller must NOT
      // fall back to res.id (that's this MIT's own id, not the chain root).
      initialTransactionId: res.standingInstruction?.initialTransactionId,
      resultCode:           res.result?.code,
      resultDescription:    res.result?.description,
      raw:                  res,
    };
  }

  async deleteRegistration(registrationId: string): Promise<{ ok: boolean; raw?: unknown }> {
    try {
      const res = await recurringFetch(
        'DELETE',
        `/v1/registrations/${encodeURIComponent(registrationId)}?entityId=${encodeURIComponent(recurringEntity())}`,
      );
      return { ok: true, raw: res };
    } catch (err) {
      return { ok: false, raw: err instanceof Error ? err.message : String(err) };
    }
  }

  async refund(
    providerPaymentId:     string,
    amountCents:           number,
    merchantTransactionId: string,
    opts?: { paymentType?: 'RF' | 'RV' },
  ): Promise<RefundResult> {
    // Peach spec (Manage payments): POST /v1/payments/{id} with
    // paymentType=RF (refund of a DB) or RV (reversal of a PA).
    // TODO(dina): confirm from Dashboard whether refunds of a V2
    // Checkout-captured payment must be booked against the Checkout
    // entity. Current default: recurring entity — matches where
    // instalments 2+ live.
    const paymentType: 'RF' | 'RV' = opts?.paymentType ?? 'RF';
    const body = toFormBody({
      entityId:              recurringEntity(),
      amount:                formatAmountCents(amountCents),
      currency:              'ZAR',
      paymentType,
      merchantTransactionId,
    });
    try {
      const res = await recurringFetch(
        'POST',
        `/v1/payments/${encodeURIComponent(providerPaymentId)}`,
        body,
      ) as PeachPaymentBody;
      return {
        status:            classifyResultCode(res.result?.code),
        providerRefundId:  res.id,
        resultCode:        res.result?.code,
        raw:               res,
      };
    } catch (err) {
      return {
        status:            'error',
        resultCode:        undefined,
        raw:               err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ─── COPYandPAY registration-only vault (Flow B) ─────────────────
  //
  // Deliberately delegates to lib/payments/peach/copyandpay/
  // registration.ts — that module is isolated (its own transport +
  // env scope) so the vault "door" cannot silently share state or
  // request-body shape with the Checkout V2 "door" above. The
  // provider methods here are just seams so tests can stub the
  // provider interface uniformly.

  async createCardRegistration(params: CardRegistrationCreateParams): Promise<CardRegistrationCreated> {
    return copyAndPayCreate({
      merchantTransactionId: params.merchantTransactionId,
      customer:              params.customer,
      customParameters:      params.customParameters,
      // shopperResultUrl is a browser-side concern (the <form action>
      // of the mounted widget) — server-side createCheckouts POST
      // does NOT accept it as a field. We accept it on the interface
      // so callers can pass it through in a single object, but drop
      // it here before hitting Peach.
    });
  }

  async getCardRegistrationStatus(resourcePath: string): Promise<PaymentStatus> {
    return copyAndPayStatus(resourcePath);
  }
}

// Exported for tests only.
export const __internals = {
  formatAmountCents,
  toFormBody,
  toPaymentStatus,
  fetchCheckoutAccessToken,
};
