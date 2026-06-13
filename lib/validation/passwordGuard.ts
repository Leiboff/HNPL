/**
 * Cheap password-quality guards. Two checks, in priority order:
 *   1. Reject passwords containing the user's email local-part as a
 *      substring (case-insensitive). Catches "jane@example.com / jane123".
 *   2. Reject passwords from a small inline list of the top-most-common
 *      passwords. Catches "password", "qwerty123", etc. — the floor of
 *      breach-list dumps.
 *
 * Deliberately NOT: zxcvbn, entropy estimation, complexity rules (mixed
 * case / digit / symbol). The brief is explicit: "Nothing more."
 *
 * The minimum-length check (≥8) lives at the call site alongside the rest
 * of the signup form validation.
 */

import { emailLocalPart } from './email';

export type PasswordWeakReason = 'contains_email_local_part' | 'common_password';

export type PasswordCheck =
  | { ok: true }
  | { ok: false; reason: PasswordWeakReason };

export function checkPassword(password: string, email: string | null | undefined): PasswordCheck {
  const localPart = emailLocalPart(email);
  if (localPart && localPart.length >= 3 && password.toLowerCase().includes(localPart)) {
    return { ok: false, reason: 'contains_email_local_part' };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, reason: 'common_password' };
  }
  return { ok: true };
}

// Top-most-common passwords. Curated from public breach dumps (SecLists
// rockyou-top-1000, NIST guidance). Kept short (~80 entries) — the goal is
// to block the absolute floor, not to be exhaustive. zxcvbn or a HaveIBeenPwned
// API call is appropriate for higher tiers; that's deliberately out of scope.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234',
  '12345678', '123456789', '1234567890', '11111111', '00000000',
  'qwerty123', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1q2w3e4r',
  '1qaz2wsx', 'abc12345', 'abcd1234', 'abcdefg1', 'abcdefgh',
  'iloveyou', 'iloveyou1', 'princess', 'princess1', 'sunshine',
  'sunshine1', 'football', 'football1', 'baseball', 'baseball1',
  'monkey123', 'dragon123', 'master123', 'letmein1', 'letmein2',
  'welcome1', 'welcome123', 'admin123', 'administrator', 'admin1234',
  'changeme', 'changeme1', 'changeme123', 'default1', 'default123',
  'guest123', 'public123', 'qwerty12', 'qwerty1234', 'qwertyui',
  'q1w2e3r4', 'q1w2e3r4t5', '1q2w3e4r5t', 'qazwsxedc', 'zaq12wsx',
  'p@ssw0rd', 'pa55w0rd', 'passw0rd', 'p@ssword', 'passw0rd1',
  'trustno1', 'starwars', 'starwars1', 'superman', 'superman1',
  'batman123', 'computer1', 'computer123', 'internet', 'whatever',
  'whatever1', 'thomas123', 'jennifer', 'jordan23', 'michael1',
  'jessica1', 'charlie1', 'andrew123', 'matthew1', 'access123',
  'samsung1', 'shadow123', 'thunder1', 'killer123', 'hunter22',
  'soccer123', 'tigger123', 'cookie123', 'banana123', 'orange12',
  'purple12', 'yellow12', 'green123', 'orange123', 'london12',
]);
