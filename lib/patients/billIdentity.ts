// ─── Who is this bill for? ───────────────────────────────────────────────
//
// THE MODEL
//   The SA ID number is the CUSTOMER key. QR and email are DELIVERY
//   methods, not identity methods.
//
//   Before this, the two issuing paths had different identity models. The
//   till captured an SA ID at issuance and left plans.patient_id NULL for
//   the checkout to resolve; createBill captured an email, never asked for
//   an ID, and stamped patient_id from the email lookup alone. That
//   asymmetry is what produced the organic-collision dead-end and the
//   four-bucket "we couldn't match this bill to you" card.
//
// WHY THIS FILE IS PURE
//   The interesting part is not the lookups — it is what to do when they
//   disagree. Keeping the decision separate from the I/O means the whole
//   truth table is testable without a database, and both server actions
//   provably share one rule rather than two implementations that drifted.
//
// THE TABLE
//   Two lookups (by ID, by email) give five cases, not two:
//
//     A  neither resolves            → issue unbound; the ID rides along
//     B  both resolve, same account  → bind at issuance
//     C  ID resolves, email doesn't  → ID is the key, so bind to it…
//                                        QR:    proceed (no address involved)
//                                        EMAIL: only if the typed address is
//                                               that account's own
//     D  email resolves, ID doesn't  → refuse
//     E  both resolve, DIFFERENT     → refuse
//
// WHY C+EMAIL IS NOT "ID WINS"
//   Under email delivery the link is SENT to the typed address. Binding to
//   X and mailing to an address that isn't X's hands a stranger a payment
//   link for X's bill — a disclosure, not merely a mis-billing. It is the
//   same vector app/checkout/[token]/_lib/discriminate.ts already blocks
//   with reject-organic-collision, and contradicting a guard we
//   deliberately kept would be incoherent.
//
// WHY D REFUSES RATHER THAN BINDING TO Y
//   Y exists but either carries no SA ID or carries a different one.
//   Binding Y to an ID they do not hold makes the key a lie; issuing
//   unbound strands a patient who does have an account. Neither is better
//   than asking reception to re-read the card in front of them.
//
//   The cost is real and deliberate: a patient whose profile has no SA ID
//   on file cannot be billed by email+ID until they complete onboarding.
//   Accepted knowingly — see the note in the practice-facing copy below.
//
// WHAT REFUSALS MAY SAY
//   Which FIELD to re-check. Never the other party's email, name or id.
//   A practice legitimately knows its own patient's ID; it does not
//   necessarily know that person's BetterNow address, and a refusal must
//   not teach it one.

export type DeliveryMethod = 'qr' | 'email';

/** Which input the practice should look at again. */
export type ConflictField = 'sa_id' | 'email' | 'both';

/** A profile matched by one of the two lookups. */
export type MatchedAccount = {
  id: string;
  /** Used ONLY to compare against the typed address. Never returned to a practice surface. */
  email: string | null;
};

export type BillIdentityInput = {
  /** From findPatientBySaId — service-role, blind-index keyed. */
  idOwner: MatchedAccount | null;
  /** From the profiles-by-email lookup. */
  emailOwner: MatchedAccount | null;
  /** Normalised (trimmed, lower-cased) typed address, or null under QR delivery. */
  typedEmail: string | null;
  delivery: DeliveryMethod;
};

export type BillIdentityResolution =
  | {
      ok: true;
      /** Which of the five cases fired — carried so callers and tests can assert on it. */
      case: 'A' | 'B' | 'C';
      /** The account to stamp on plans.patient_id and applications.patient_id, or null to issue unbound. */
      patientId: string | null;
    }
  | {
      ok: false;
      case: 'C' | 'D' | 'E';
      field: ConflictField;
      message: string;
    };

// ─── Practice-facing refusal copy ────────────────────────────────────────
//
// Written for a receptionist with the patient standing there. Each one
// names a field and a physical action, because the fix is nearly always
// "look at the card again", and none of them reveals anything about the
// account we matched.

const MSG = {
  /** C under email delivery: the ID's account is real, the typed address isn't its. */
  emailNotTheIdsOwn:
    'That ID number belongs to an existing BetterNow account, but the email address you entered ' +
    'isn’t the one on it. Check the email address, or send this bill by QR instead.',
  /** D: the email has an account; the ID doesn't resolve to one. */
  idDoesNotMatchEmailAccount:
    'That email address belongs to an existing BetterNow account, but the ID number you entered ' +
    'isn’t the one on it. Check the ID number against the patient’s card.',
  /** E: two different accounts. */
  differentPeople:
    'The ID number and the email address belong to two different BetterNow accounts. ' +
    'Check both against the patient’s card before issuing this bill.',
} as const;

/**
 * Decide who a bill belongs to, given the two lookups and the delivery method.
 *
 * Pure: no I/O, no clock, no randomness. Every branch is a row of the table above.
 */
export function resolveBillIdentity(input: BillIdentityInput): BillIdentityResolution {
  const { idOwner, emailOwner, typedEmail, delivery } = input;

  // ── E — two accounts, two people ───────────────────────────────────────
  // Checked FIRST: it is the only case where both lookups succeed and
  // disagree, and it must not be reachable by falling through C or D.
  if (idOwner && emailOwner && idOwner.id !== emailOwner.id) {
    return { ok: false, case: 'E', field: 'both', message: MSG.differentPeople };
  }

  // ── B — both resolve to the same account ───────────────────────────────
  if (idOwner && emailOwner) {
    return { ok: true, case: 'B', patientId: idOwner.id };
  }

  // ── D — the email has an account, the ID does not ──────────────────────
  if (!idOwner && emailOwner) {
    return { ok: false, case: 'D', field: 'sa_id', message: MSG.idDoesNotMatchEmailAccount };
  }

  // ── C — the ID has an account, the email does not ──────────────────────
  if (idOwner && !emailOwner) {
    if (delivery === 'qr') {
      // Nothing is sent anywhere; the patient scans a code on the screen in
      // front of them. The ID is the key, so it wins outright.
      return { ok: true, case: 'C', patientId: idOwner.id };
    }

    // Email delivery. The typed address must be this account's own.
    //
    // Compared explicitly rather than inferred from emailOwner being null:
    // if the two ever agree, the email lookup should have found the same
    // row and this would be case B. Doing it this way means the RULE holds
    // even when the lookup misses — a differently-cased stored address, a
    // role that changed, an unconfirmed row — instead of the rule holding
    // only as long as two lookups stay in step.
    const ownEmail = (idOwner.email ?? '').trim().toLowerCase();
    const typed    = (typedEmail ?? '').trim().toLowerCase();
    if (ownEmail && typed && ownEmail === typed) {
      return { ok: true, case: 'C', patientId: idOwner.id };
    }

    return { ok: false, case: 'C', field: 'email', message: MSG.emailNotTheIdsOwn };
  }

  // ── A — neither resolves; a genuinely new patient ──────────────────────
  return { ok: true, case: 'A', patientId: null };
}

/** Exported for tests that assert copy without duplicating the strings. */
export const BILL_IDENTITY_MESSAGES = MSG;
