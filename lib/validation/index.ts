// Barrel for the shared validators. Every place in the app that needs to
// validate an email, phone, SA ID, or password imports from here — never
// inline a regex. A source-text regression test in this folder bans the
// patterns from appearing elsewhere.

export { isValidEmail, emailLocalPart } from './email';
export { normalizePhoneZA, isValidPhoneZA, isNormalizedPhoneZA } from './phone';
export {
  toNationalDigitsZA,
  formatNationalZA,
  nationalToE164ZA,
  ZA_DIAL_CODE,
  ZA_NATIONAL_DIGITS,
} from './phone';
export type { PhoneNormalizeOptions } from './phone';
export { validateSaId, saIdDateOfBirth, saIdAge } from './saId';
export type { SaIdInvalidReason, SaIdValidation } from './saId';
export { checkPassword } from './passwordGuard';
export type { PasswordWeakReason, PasswordCheck } from './passwordGuard';
