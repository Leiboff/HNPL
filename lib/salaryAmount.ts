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
const MAX_SALARY_AMOUNT = 10_000_000;

export function isValidSalaryAmount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_SALARY_AMOUNT
  );
}
