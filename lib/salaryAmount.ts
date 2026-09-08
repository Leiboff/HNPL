/**
 * Single source of truth for validating `profiles.salary_amount` — the
 * patient's monthly income in rand, captured at signup (onboarding identity
 * step, alongside SA ID + salary day) and editable afterwards from Account
 * -> Personal details.
 *
 * Deliberately permissive: no floor/ceiling tied to any affordability rule
 * (there isn't one wired up yet — see lib/underwriting/affordabilityPolicy.ts,
 * which is the seam the real credit check lands in).
 * Just "a positive, finite, sane rand amount" — the same posture the SA ID
 * and salary-day validators take, keeping policy decisions out of the input
 * boundary.
 */

// A generous ceiling to catch fat-finger entry (e.g. cents typed as rand)
// without imposing a real income cap. Nothing in the product reasons about
// this number; it exists purely to reject obvious mis-entry.
export const MAX_SALARY_AMOUNT = 100_000;

function hasAtMostTwoDecimalPlaces(value: number): boolean {
  const cents = value * 100;
  const nearestCent = Math.round(cents);

  // Allow the tiny representation error introduced by binary floating point
  // (for example, 1.01 * 100) without accepting a genuine fraction of a cent.
  return Math.abs(cents - nearestCent) <= Number.EPSILON * Math.max(1, Math.abs(cents));
}

export function isValidSalaryAmount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_SALARY_AMOUNT &&
    hasAtMostTwoDecimalPlaces(value)
  );
}
