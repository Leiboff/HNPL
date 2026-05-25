// SERVER-ONLY. Never import this file in a client component.
// The PAYSTACK_SECRET_KEY must never be exposed to the browser.

const BASE_URL = 'https://api.paystack.co';

export async function paystackRequest<T = unknown>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    throw new Error('PAYSTACK_SECRET_KEY is not set in environment variables.');
  }

  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      ...options.headers,
    },
  });

  const body = await res.json() as T;

  if (!res.ok) {
    const message =
      (body as { message?: string }).message ?? `HTTP ${res.status} ${res.statusText}`;
    throw new Error(`Paystack error: ${message}`);
  }

  return body;
}
