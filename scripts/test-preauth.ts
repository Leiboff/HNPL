/**
 * Paystack preauthorization exerciser — Testing-1 in the rolling-preauth build.
 *
 * Purpose: validate, against TEST keys only, that
 *   (a) the preauthorization endpoints are enabled on this Paystack account,
 *   (b) the real max value of `expire_after_days` (docs disagree: prose says
 *       10, parameter table says 30 — we try 30, fall back to 10),
 *   (c) the synchronous shapes of reserve / capture / release / status,
 *   (d) the `fees` field on reserve and capture (for unit economics).
 *
 * Webhook event shapes are NOT captured by this script — Paystack delivers
 * those out-of-band. After this script runs, inspect either your dev-server
 * logs (existing webhook handler already prefixes with `[paystack-webhook]`
 * and falls through to "Unhandled event type" for preauth events, which is
 * fine — that confirms arrival) OR the Paystack dashboard event feed for the
 * exact payloads.
 *
 * Usage:
 *   npm install              (one-time, picks up the new `tsx` devDep)
 *   npm run test:preauth     (loads .env.local, runs this file)
 *
 * Env vars:
 *   PAYSTACK_SECRET_KEY        (required; must start with sk_test_)
 *   PAYSTACK_TEST_AUTH_CODE    (optional; if absent → bootstrap mode)
 *   PAYSTACK_TEST_EMAIL        (required if PAYSTACK_TEST_AUTH_CODE set;
 *                               MUST match the email the card was first
 *                               tokenised with — Paystack enforces this)
 */

import crypto from 'node:crypto';
import readline from 'node:readline/promises';

const BASE = 'https://api.paystack.co';
const KEY  = process.env.PAYSTACK_SECRET_KEY;

if (!KEY) {
  console.error('✗ PAYSTACK_SECRET_KEY is not set. Add it to .env.local and re-run.');
  process.exit(1);
}
if (!KEY.startsWith('sk_test_')) {
  console.error('✗ Refusing to run: PAYSTACK_SECRET_KEY is not a test key (must start with sk_test_).');
  console.error('  This script performs destructive actions (reserves money, captures, releases).');
  process.exit(1);
}

// ── Logging helpers ──────────────────────────────────────────────────────────

const T0 = Date.now();
const ms = () => `${String(Date.now() - T0).padStart(5)}ms`;

function h1(label: string) {
  console.log(`\n\x1b[36m━━ ${label} ${'━'.repeat(Math.max(0, 70 - label.length))}\x1b[0m`);
}
function info(label: string, body?: unknown) {
  console.log(`[${ms()}] ${label}`);
  if (body !== undefined) console.dir(body, { depth: 8, colors: true });
}
function ok(label: string)  { console.log(`[${ms()}] \x1b[32m✓\x1b[0m ${label}`); }
function warn(label: string){ console.log(`[${ms()}] \x1b[33m!\x1b[0m ${label}`); }
function bad(label: string) { console.log(`[${ms()}] \x1b[31m✗\x1b[0m ${label}`); }

// ── HTTP helper ──────────────────────────────────────────────────────────────

type PaystackResponse<T = unknown> = {
  status?: boolean;
  message?: string;
  data?: T;
  meta?: unknown;
};

type Result<T = unknown> = {
  httpStatus: number;
  ok: boolean;
  body: PaystackResponse<T>;
};

async function paystack<T = unknown>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: PaystackResponse<T>;
  try {
    parsed = JSON.parse(text) as PaystackResponse<T>;
  } catch {
    parsed = { message: `(non-JSON response) ${text.slice(0, 200)}` };
  }
  return { httpStatus: res.status, ok: res.ok, body: parsed };
}

function refOf(suffix: string): string {
  return `bn-test-${crypto.randomBytes(4).toString('hex')}-${suffix}`;
}

// ── Bootstrap: interactively tokenise a test card and print the auth code ────

async function bootstrap(): Promise<never> {
  h1('BOOTSTRAP MODE — no PAYSTACK_TEST_AUTH_CODE in env');
  info('Will create a small R1.00 transaction to tokenise a reusable card.');

  const email = process.env.PAYSTACK_TEST_EMAIL ?? `preauth-test-${Date.now()}@betternow.co.za`;
  const reference = refOf('boot');

  const init = await paystack<{ authorization_url: string; reference: string }>(
    'POST',
    '/transaction/initialize',
    {
      email,
      amount: 100,                  // 100 kobo = R1.00
      currency: 'ZAR',
      reference,
      channels: ['card'],
      custom_filters: { reusable: true },   // matches existing card-reg flow
      metadata: { purpose: 'preauth_bootstrap' },
    },
  );
  info('POST /transaction/initialize', init);
  if (!init.ok || !init.body.data?.authorization_url) {
    bad('Could not initialize transaction — stopping.');
    process.exit(1);
  }

  const url = init.body.data.authorization_url;
  console.log('\n┌──────────────────────────────────────────────────────────────────────┐');
  console.log('│  OPEN THIS URL AND COMPLETE CHECKOUT:                                │');
  console.log(`│  ${url}`);
  console.log('│                                                                      │');
  console.log('│  Use the Paystack test card:                                         │');
  console.log('│    Card no.  4084 0840 8408 4081                                     │');
  console.log('│    CVV       408                                                     │');
  console.log('│    Expiry    any future date (e.g. 12/30)                            │');
  console.log('│    PIN       0000                                                    │');
  console.log('│    OTP       123456                                                  │');
  console.log('└──────────────────────────────────────────────────────────────────────┘\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter once the checkout shows "Successful"... ');
  rl.close();

  type VerifyData = {
    status: string;
    authorization?: {
      authorization_code?: string;
      reusable?: boolean;
      channel?: string;
      bin?: string;
      last4?: string;
      brand?: string;
    };
    customer?: { email?: string };
    fees?: number;
  };
  const verify = await paystack<VerifyData>('GET', `/transaction/verify/${reference}`);
  info('GET /transaction/verify/:reference', verify);

  const authCode = verify.body.data?.authorization?.authorization_code;
  const reusable = verify.body.data?.authorization?.reusable;
  if (!authCode) {
    bad('No authorization_code on the verified transaction. Did the checkout actually complete?');
    process.exit(1);
  }
  if (reusable === false) {
    warn('Card came back with reusable=false — Paystack will not allow charging it again.');
    warn('Your account may be forcing 3DS on all cards. Preauth needs a reusable card to work.');
    warn('Stop here and contact Paystack if every bootstrap returns reusable=false.');
  }

  console.log('\n┌──────────────────────────────────────────────────────────────────────┐');
  console.log('│  SUCCESS. Add these two lines to .env.local and re-run the script:   │');
  console.log('├──────────────────────────────────────────────────────────────────────┤');
  console.log(`│  PAYSTACK_TEST_AUTH_CODE=${authCode}`);
  console.log(`│  PAYSTACK_TEST_EMAIL=${email}`);
  console.log('└──────────────────────────────────────────────────────────────────────┘\n');
  console.log(`Card: ${verify.body.data?.authorization?.brand} •••• ${verify.body.data?.authorization?.last4}`);
  console.log(`Reusable: ${reusable}`);
  console.log(`Fees on initial R1.00 transaction (kobo): ${verify.body.data?.fees ?? 'n/a'}`);
  process.exit(0);
}

// ── Main exerciser ──────────────────────────────────────────────────────────

type ReserveData = {
  reference?: string;
  status?: string;
  amount?: number;
  expires_at?: string;
  expire_after_days?: number;
  fees?: number;
  authorization?: { authorization_code?: string };
};

async function tryReserve(amountCents: number, expireDays: number, reference: string, email: string, authCode: string): Promise<Result<ReserveData>> {
  return paystack<ReserveData>('POST', '/preauthorization/reserve_authorization', {
    email,
    amount: amountCents,
    currency: 'ZAR',
    authorization_code: authCode,
    expire_after_days: expireDays,
    expire_action: 'release',
    reference,
    metadata: { purpose: 'preauth_test' },
  });
}

async function main() {
  const authCode = process.env.PAYSTACK_TEST_AUTH_CODE;
  const email    = process.env.PAYSTACK_TEST_EMAIL;
  if (!authCode || !email) {
    return bootstrap();
  }

  h1(`PREAUTH EXERCISE — ${KEY!.slice(0, 12)}…  card ${authCode.slice(0, 10)}…  ${email}`);

  // ── 1. Reserve the full plan amount, probing expire_after_days ───────────
  const PLAN_CENTS = 150_000;     // R1,500.00
  let effectiveMax: number | null = null;
  let usedReserve: Result<ReserveData> | null = null;
  let usedRef = '';

  h1('STEP 1 — Reserve R1,500.00 (probing max expire_after_days)');

  for (const days of [30, 10, 5] as const) {
    const ref = refOf(`h1d${days}`);
    info(`Trying expire_after_days=${days}`, { reference: ref });
    const res = await tryReserve(PLAN_CENTS, days, ref, email, authCode);
    info('  ↳ response', res);
    if (res.ok) {
      effectiveMax = days;
      usedReserve  = res;
      usedRef      = ref;
      ok(`Reserve succeeded at expire_after_days=${days}`);
      break;
    }
    warn(`Reserve at ${days} days returned HTTP ${res.httpStatus}: ${res.body.message ?? 'no message'}`);
  }

  if (!usedReserve || !effectiveMax) {
    bad('Reserve failed at 30, 10, AND 5 days. This usually means preauthorization is not enabled');
    bad('on your Paystack account, or the card / email combination is invalid.');
    bad('Stop here. Contact Paystack support to confirm preauth is enabled for this merchant.');
    process.exit(2);
  }

  // ── 2. Fetch preauth status ──────────────────────────────────────────────
  h1('STEP 2 — GET /preauthorization/:reference');
  const status1 = await paystack('GET', `/preauthorization/${usedRef}`);
  info('GET /preauthorization/:reference', status1);

  // ── 3. Capture partial amount (1/3) ──────────────────────────────────────
  const CAPTURE_CENTS = Math.floor(PLAN_CENTS / 3);   // R500.00
  h1(`STEP 3 — Capture R${CAPTURE_CENTS / 100} (1/3 of hold)`);
  const capture1 = await paystack('POST', '/preauthorization/capture', {
    reference: usedRef,
    amount:    CAPTURE_CENTS,
    currency:  'ZAR',
  });
  info('POST /preauthorization/capture', capture1);
  if (!capture1.ok) {
    bad('Capture failed — continuing to observe state, but downstream steps may not behave.');
  }

  // ── 4. Observe auto-release of remainder ─────────────────────────────────
  h1('STEP 4 — Re-fetch status (remainder should be auto-released by Paystack)');
  await new Promise((r) => setTimeout(r, 2_500));
  const status2 = await paystack('GET', `/preauthorization/${usedRef}`);
  info('GET /preauthorization/:reference (post-capture)', status2);

  // ── 5. Re-reserve the remainder ──────────────────────────────────────────
  const REMAINING_CENTS = PLAN_CENTS - CAPTURE_CENTS; // R1,000.00
  const ref2 = refOf('h2');
  h1(`STEP 5 — Re-reserve remainder R${REMAINING_CENTS / 100}`);
  const reserve2 = await tryReserve(REMAINING_CENTS, effectiveMax, ref2, email, authCode);
  info('POST /preauthorization/reserve_authorization (remainder)', reserve2);

  // ── 6. Release the new hold (clean up) ───────────────────────────────────
  if (reserve2.ok) {
    h1('STEP 6 — Release the remainder hold (intentional cleanup)');
    const release1 = await paystack('POST', '/preauthorization/release', { reference: ref2 });
    info('POST /preauthorization/release', release1);
  } else {
    warn('Skipping STEP 6 — remainder reserve did not succeed.');
  }

  // ── 7. Final status check on both refs ───────────────────────────────────
  h1('STEP 7 — Final status check');
  const finalA = await paystack('GET', `/preauthorization/${usedRef}`);
  info(`GET /preauthorization/${usedRef}`, finalA);
  if (reserve2.ok) {
    const finalB = await paystack('GET', `/preauthorization/${ref2}`);
    info(`GET /preauthorization/${ref2}`, finalB);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  h1('SUMMARY');
  console.log(`  Effective max expire_after_days : ${effectiveMax}`);
  console.log(`  Plan amount                     : R${PLAN_CENTS / 100} (${PLAN_CENTS} cents)`);
  console.log(`  Partial capture                 : R${CAPTURE_CENTS / 100} (${CAPTURE_CENTS} cents)`);
  console.log(`  Remainder re-reserve            : R${REMAINING_CENTS / 100} (${REMAINING_CENTS} cents)`);
  console.log(`  Hold references                 : ${usedRef}${reserve2.ok ? `, ${ref2}` : ''}`);
  console.log('');
  console.log('  Fees observed (kobo / cents):');
  console.log(`    initial reserve  : ${usedReserve.body.data?.fees ?? 'n/a'}`);
  console.log(`    capture          : ${(capture1.body.data as { fees?: number } | undefined)?.fees ?? 'n/a'}`);
  if (reserve2.ok) console.log(`    remainder reserve: ${reserve2.body.data?.fees ?? 'n/a'}`);
  console.log('');
  console.log('  Webhook events expected (check your dev-server logs or Paystack dashboard):');
  console.log('    • preauthorization.reserve.success   ×2');
  console.log('    • preauthorization.capture.success   ×1');
  console.log('    • preauthorization.release.success   ×1 explicit  + possibly 1 auto-release');
  console.log('');
}

main().catch((err) => {
  bad(`Uncaught error: ${(err as Error).message}`);
  console.error(err);
  process.exit(1);
});
