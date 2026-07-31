// ─── Bill-amount validation limits ─────────────────────────────────
//
// Single source of truth for the min/max a practice may bill, shared
// by the server action (app/practice/bills/new/actions.ts) and the
// client form (app/practice/bills/new/BillForm.tsx). Keeping ONE
// constant means the two validators can never drift.
//
// Configurable via env (NEXT_PUBLIC_ so the client bundle can read the
// same value the server enforces):
//   NEXT_PUBLIC_MIN_BILL_AMOUNT  — floor in Rands. Default 1.
//   NEXT_PUBLIC_MAX_BILL_AMOUNT  — ceiling in Rands. Default 50000.
//
// Why the default floor is R1, not the old R500:
//   Peach's SANDBOX approves specific test amounts — R92.00 per
//   instalment is a known "approve" amount. To hit that we need to
//   bill totals whose per-instalment split lands on 92.00:
//     • R276 on Pay-in-3  → R92 / R92 / R92
//     • R184 on Pay-in-2  → R92 / R92
//   The old R500 floor blocked both. R1 lets them through while still
//   rejecting a nonsensical R0 total (which would produce R0
//   instalments — not a chargeable card authorisation; the first
//   instalment MUST be a real debit > the processor minimum).
//
//   Set NEXT_PUBLIC_MIN_BILL_AMOUNT=0 explicitly to allow R0 in a
//   throwaway environment; the default keeps a >0 floor so a fat-
//   fingered R0 bill in a real environment is still rejected.
//
// TODO(dina): if per-brand or per-environment floors are ever needed,
// promote this to a platform-admin setting (a `platform_settings`
// row + admin UI). That's an additive migration; deferred until the
// requirement is real. An env constant covers the sandbox-testing
// need today without one.

function readAmountEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  // Guard against a malformed env value silently disabling validation.
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export const MIN_BILL_AMOUNT = readAmountEnv('NEXT_PUBLIC_MIN_BILL_AMOUNT', 1);
export const MAX_BILL_AMOUNT = readAmountEnv('NEXT_PUBLIC_MAX_BILL_AMOUNT', 50000);

/** Rands, formatted with a thousands separator for user-facing copy. */
export function formatRandLimit(n: number): string {
  return `R${n.toLocaleString('en-ZA')}`;
}

/** Shared validity predicate — server + client call the same function. */
export function isAllowedBillAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount >= MIN_BILL_AMOUNT && amount <= MAX_BILL_AMOUNT;
}
