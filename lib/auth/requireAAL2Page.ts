import { redirect } from 'next/navigation';
import {
  requireAAL2,
  SECURITY_CHALLENGE_ROUTE,
  SECURITY_ENROL_ROUTE,
  type AssuranceTier,
} from './aal';

// ─── Page-level AAL2 gate ──────────────────────────────────────────────
//
// The server-action form of the guard (`requireAAL2`) returns a value so
// the caller can render an inline error. Pages cannot render an inline
// error into a form they were about to draw — they have to send the
// operator somewhere they can fix it. This is that adaptor: refuse ⇒
// redirect to /security, with the query param that tells the security page
// whether the user needs to ENROL a factor or just re-CHALLENGE an
// existing one.
//
// Used by the customer-PII pages (a `standard`-tier privileged read). It
// deliberately does NOT wrap the whole admin area — keying page gates on
// the operation, not the role, is the same discipline the action guards
// follow. Only the pages that perform one of the seven privileged
// operations carry it.

/**
 * Enforce `tier` on a page. On success returns nothing and the page
 * continues; on failure it never returns — it throws Next's redirect.
 *
 * MUST be called AFTER the page's own role gate has confirmed the caller
 * is privileged, for the same before-the-data reason the role gate itself
 * runs first: an unassured caller's data read must not be in flight by the
 * time the refusal is decided.
 */
export async function requireAAL2Page(tier: AssuranceTier): Promise<void> {
  const gate = await requireAAL2(tier);
  if (gate.ok) return;

  // Each branch calls redirect(), which returns `never` (it throws), so
  // there is no fall-through between cases.
  switch (gate.refusal.kind) {
    case 'unauthenticated':
    case 'malformed':
      redirect('/login');
    case 'aal1':
      redirect(gate.refusal.canEnrol ? SECURITY_CHALLENGE_ROUTE : SECURITY_ENROL_ROUTE);
    case 'stale':
      redirect(SECURITY_CHALLENGE_ROUTE);
  }
}
