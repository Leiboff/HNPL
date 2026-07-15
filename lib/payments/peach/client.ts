// SERVER-ONLY. Never import this file in a client component.
// PEACH_ACCESS_TOKEN must never reach the browser.

import type {
  PaymentProvider,
  ChargeSavedCardParams,
  ChargeResult,
  CheckoutCreateParams,
  CheckoutCreated,
  PaymentStatus,
  RefundResult,
} from '../provider';
import { classifyResultCode } from './resultCodes';

// ─── Env-driven configuration ───────────────────────────────────────
//
// Read lazily so tests can swap process.env before the first call. The
// four vars are:
//
//   PEACH_BASE_URL             — e.g. https://sandbox-card.peachpayments.com
//                                or the production host per the sandbox doc
//   PEACH_ENTITY_ID            — the merchant entity for card payments
//   PEACH_ACCESS_TOKEN         — Bearer token
//   PEACH_WEBHOOK_SECRET_KEY   — 64-char hex, used to AES-256-GCM
//                                decrypt inbound webhooks (see webhook.ts)

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in environment variables.`);
  return v;
}

function baseUrl(): string { return requireEnv('PEACH_BASE_URL').replace(/\/$/, ''); }
function entityId(): string { return requireEnv('PEACH_ENTITY_ID'); }
function accessToken(): string { return requireEnv('PEACH_ACCESS_TOKEN'); }

// Hard cap on Peach call duration. Vercel Hobby functions time out at
// 10s; we leave a couple of seconds of headroom.
const DEFAULT_TIMEOUT_MS = 8_000;

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

// Peach expects application/x-www-form-urlencoded for OPPWA v1 calls.
// We flatten { standingInstruction: { mode: 'INITIAL' } } to
// standingInstruction.mode=INITIAL, and customer / card sub-objects
// likewise.
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

async function peachFetch(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${baseUrl()}${path}`;
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken()}`,
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
  // ── Registration-return shape (widget in registration-only mode) ──
  // COPYandPAY docs place the registration id under `id` when the
  // paymentType/paymentBrand indicate a registration, and under
  // `registrationId` when it accompanies a payment. We check both.
};

type PeachCheckoutCreateResponse = {
  id:        string;
  integrity?: string;
  result?:   PeachResult;
};

// Extract the reusable registration id from either shape.
function pickRegistrationId(body: PeachPaymentBody): string | undefined {
  if (body.registrationId) return body.registrationId;
  // Widget in "registration only" mode returns the id under `id` with a
  // paymentType of `null` or 'RG' — treat any populated id + no amount
  // as registration-shaped when registrationId is absent.
  return undefined;
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
    registrationId:        pickRegistrationId(body),
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
    const form: Record<string, unknown> = {
      entityId:              entityId(),
      merchantTransactionId: params.merchantTransactionId,
    };

    // Amount + currency are required for a payment-bearing checkout, and
    // OPTIONAL when the widget is used in registration-only mode. The
    // Peach docs are explicit that omitting paymentType + amount +
    // currency together indicates a registration-only shape.
    const isRegistrationOnly = params.createRegistration && (params.amountCents == null || params.amountCents === 0);
    if (!isRegistrationOnly) {
      if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
        throw new Error(`Peach createCheckout: amountCents must be a positive integer; got ${params.amountCents}`);
      }
      form.amount      = formatAmountCents(params.amountCents);
      form.currency    = params.currency ?? 'ZAR';
      form.paymentType = params.paymentType ?? 'DB';
    }

    if (params.createRegistration) form.createRegistration = 'true';

    if (params.standingInstruction) form.standingInstruction = { ...params.standingInstruction };
    if (params.customer)            form.customer            = { ...params.customer };

    const flat = toFormBody(form);
    const extra = toCustomParametersBody(params.customParameters);
    const body  = extra ? `${flat}&${extra}` : flat;

    const res = await peachFetch('POST', '/v1/checkouts', body) as PeachCheckoutCreateResponse;
    if (!res?.id) throw new Error('Peach createCheckout: response missing id');
    return { checkoutId: res.id, raw: res };
  }

  async getCheckoutStatus(resourcePath: string): Promise<PaymentStatus> {
    // The widget appends resourcePath = /v1/checkouts/{id}/payment on
    // return. We tack the entityId onto the query string per the docs.
    if (!resourcePath.startsWith('/')) resourcePath = `/${resourcePath}`;
    const sep = resourcePath.includes('?') ? '&' : '?';
    const path = `${resourcePath}${sep}entityId=${encodeURIComponent(entityId())}`;
    const res = await peachFetch('GET', path) as PeachPaymentBody;
    return toPaymentStatus(res);
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentStatus> {
    const path = `/v1/payments/${encodeURIComponent(providerPaymentId)}?entityId=${encodeURIComponent(entityId())}`;
    const res = await peachFetch('GET', path) as PeachPaymentBody;
    return toPaymentStatus(res);
  }

  async chargeSavedCard(params: ChargeSavedCardParams): Promise<ChargeResult> {
    if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
      throw new Error(`Peach chargeSavedCard: amountCents must be a positive integer; got ${params.amountCents}`);
    }
    const form: Record<string, unknown> = {
      entityId:              entityId(),
      amount:                formatAmountCents(params.amountCents),
      currency:              params.currency ?? 'ZAR',
      paymentType:           'DB',
      merchantTransactionId: params.merchantTransactionId,
      standingInstruction:   { ...params.standingInstruction },
    };
    const body = toFormBody(form);
    let res: PeachPaymentBody;
    try {
      res = await peachFetch(
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
      status:            classifyResultCode(res.result?.code),
      providerPaymentId: res.id,
      resultCode:        res.result?.code,
      resultDescription: res.result?.description,
      raw:               res,
    };
  }

  async deleteRegistration(registrationId: string): Promise<{ ok: boolean; raw?: unknown }> {
    try {
      const res = await peachFetch(
        'DELETE',
        `/v1/registrations/${encodeURIComponent(registrationId)}?entityId=${encodeURIComponent(entityId())}`,
      );
      return { ok: true, raw: res };
    } catch (err) {
      return { ok: false, raw: err instanceof Error ? err.message : String(err) };
    }
  }

  async refund(
    providerPaymentId: string,
    amountCents:       number,
    merchantTransactionId: string,
  ): Promise<RefundResult> {
    const body = toFormBody({
      entityId:              entityId(),
      amount:                formatAmountCents(amountCents),
      currency:              'ZAR',
      paymentType:           'RF',
      merchantTransactionId,
    });
    try {
      const res = await peachFetch(
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
}

// Exported for tests only.
export const __internals = { formatAmountCents, toFormBody, toPaymentStatus };
