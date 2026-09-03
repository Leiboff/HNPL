/**
 * Single source of truth for validating `profiles.salary_amount` — the
 * patient's monthly income in rand, captured at signup (onboarding identity
 * step, alongside SA ID + salary day) and editable afterwards from Account
 * -> Personal details.
 *
 * Deliberately permissive: no floor or ceiling tied to any affordability
 * rule. Just "a positive, finite, sane rand amount" — the same posture the
 * SA ID and salary-day validators take, keeping policy decisions out of the
 * input boundary.
 *
 * The affordability rules live in lib/underwriting/limit.ts and operate on
 * this figure as the patient's DECLARED gross, where it can only ever lower
 * a limit and never raise one. Rejecting an implausible-but-positive figure
 * here would be the wrong place to do it: a patient who overstates their
 * income gains nothing, and one who understates it is believed.
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
