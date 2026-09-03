/**
 * Which roles must carry a second factor.
 *
 * MFA is mandatory for `admin` and `sales` only. `patient`,
 * `practice_admin`, `practice_staff` and `practice_provider` are out of
 * scope and every change in this pass must leave them untouched — no
 * forced enrolment, no step-up, no altered routing.
 *
 * This list is the ONE place the mandatory-MFA role set is named, so the
 * sign-in step-up (C) and the /security gate (B) cannot drift apart. It is
 * deliberately separate from the OPERATION guards: `requireAAL2` keys on
 * the operation, never on the role, because a role-keyed operation guard
 * silently stops protecting anything the day a fourth privileged role
 * appears — `sales` itself did not exist six months ago. This set governs
 * only "who is FORCED to enrol", which is a genuinely role-shaped
 * question.
 */
export const MFA_REQUIRED_ROLES = ['admin', 'sales'] as const;

export type MfaRequiredRole = (typeof MFA_REQUIRED_ROLES)[number];

export function isMfaRequiredRole(role: string | null | undefined): role is MfaRequiredRole {
  return role === 'admin' || role === 'sales';
}
