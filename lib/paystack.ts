// SERVER-ONLY. Never import this file in a client component.
// The PAYSTACK_SECRET_KEY must never be exposed to the browser.

const BASE_URL = 'https://api.paystack.co';

// Hard ceiling on Paystack call duration. /transaction/initialize and
// /transaction/verify normally respond in well under a second;
// charge_authorization in well under five. Anything past 8s is a stall
// and would risk exceeding Vercel's Hobby function timeout, leaving
// the caller hung waiting on a response that never lands. We abort
// the fetch instead so the caller's try/catch gets a clean error.
const DEFAULT_TIMEOUT_MS = 8_000;

type PaystackRequestOptions = RequestInit & {
  /** Override the 8s default; useful for tests or unusually slow calls. */
  timeoutMs?: number;
};

export async function paystackRequest<T = unknown>(
  endpoint: string,
  options: PaystackRequestOptions = {},
): Promise<T> {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    throw new Error('PAYSTACK_SECRET_KEY is not set in environment variables.');
  }

  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${BASE_URL}${endpoint}`;
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        ...fetchOptions.headers,
      },
    });

    const body = await res.json() as T;

    if (!res.ok) {
      const message =
        (body as { message?: string }).message ?? `HTTP ${res.status} ${res.statusText}`;
      throw new Error(`Paystack error: ${message}`);
    }

    return body;
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new Error(`Paystack timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
