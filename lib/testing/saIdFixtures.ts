/**
 * SA ID numbers for tests, sorted by whether they actually pass validateSaId.
 *
 * WHY THIS FILE EXISTS
 *   '9001015800086' appears in eight test files and LOOKS like a valid South
 *   African ID number. It is not — it fails the Luhn checksum. Every one of
 *   those uses is harmless, because none of them puts it through
 *   validateSaId: idEncryption.test.ts wants an arbitrary 13-digit string to
 *   encrypt, the pglite tests want a stable value to hash, and
 *   CounterSessionForm.test.tsx types it into a form whose server action is
 *   mocked. But borrowing it for a test that DOES validate fails in a way
 *   that looks like a bug in the code under test.
 *
 *   So: if your test only needs 13 digits, anything here works. If your test
 *   needs an ID that validateSaId accepts, take one from VALID_SA_IDS.
 *
 * WHAT MAKES ONE VALID (lib/validation/saId.ts)
 *   YYMMDD must parse as a real date, position 11 (citizenship) must be 0, 1
 *   or 2, and the 13th digit is a Luhn check digit over the first 12.
 *   Century pivot: 20YY is tried first and falls back to 19YY if that would
 *   be in the future, so a fixture's implied age drifts as time passes —
 *   which matters only for the 18+ gate, not for validity.
 */

/** IDs that pass validateSaId — checksum, date and citizenship digit all good. */
export const VALID_SA_IDS = [
  '9001015800088',   // 1990-01-01, male, SA citizen
  '8506155001082',   // 1985-06-15, male, SA citizen
  '0002295000083',   // 2000-02-29, male, SA citizen — leap day, exercises buildUtcDate
] as const;

/** A single valid ID, for tests that just need one. */
export const VALID_SA_ID = VALID_SA_IDS[0];

/**
 * 13-digit strings that are NOT valid IDs, with the reason validateSaId gives.
 * Useful for negative cases, and for making the trap above explicit.
 */
export const INVALID_SA_IDS = [
  { id: '9001015800086', reason: 'checksum' },     // the one that looks valid
  { id: '9013015800088', reason: 'date' },         // month 13
  { id: '9001015800380', reason: 'citizenship' },  // position 11 is 3
] as const;
