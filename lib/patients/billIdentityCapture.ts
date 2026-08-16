import { encryptId } from '@/lib/idEncryption';
import { validateSaId, saIdAge, isValidEmail } from '@/lib/validation';
import { findPatientBySaId } from './findPatientBySaId';
import {
  resolveBillIdentity,
  type ConflictField,
  type DeliveryMethod,
  type MatchedAccount,
} from './billIdentity';

// ─── Capturing the identity on a bill, once, for both surfaces ───────────
//
// The dashboard (createBill) and the till (issueCounterSession) issue the
// same thing and used to capture identity two different ways. This module
// is the single capture: validate, age-gate, look up, decide, encrypt.
//
// It is deliberately the ONLY place that calls findPatientBySaId from an
// issuing path, so the two disclosure decisions below hold for both
// surfaces by construction rather than by both remembering to.
//
// DISCLOSURE 1 — the matched account's identity never leaves this module.
//   findPatientBySaId returns { id, email }. The email is used ONLY to
//   compare against the address the practice typed (see billIdentity.ts,
//   case C). It is never returned to a caller, so it cannot reach a till
//   screen, a dashboard summary, a server-action response or a log. A
//   practice legitimately knows its own patient's ID number; it does not
//   necessarily know that person's BetterNow address, and a bill-issuing
//   screen must not teach it one.
//
// DISCLOSURE 2 — this is an existence oracle, and that is accepted.
//   Anyone who can reach an issuing surface can type SA ID numbers and
//   learn, one bit at a time, whether each has a BetterNow account. It is
//   behind practice auth, the ID must already be known to ask the
//   question, and the answer carries nothing else.
//
//   Worth knowing rather than rediscovering: the TILL path authenticates
//   with a DEVICE SECRET, not a user session, so a stolen unlocked till
//   inherits this oracle for as long as it stays unlocked. Judged
//   acceptable against the same one-bit answer; if that judgement is ever
//   revisited, this is the call site to rate-limit.

export type BillIdentityCaptureInput = {
  /** Service-role client. The blind-index column has no client-facing SELECT policy. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any;
  saIdNumber: string;
  /** Required under email delivery; ignored (and not looked up) under QR. */
  patientEmail?: string | null;
  delivery: DeliveryMethod;
};

export type BillIdentityCapture =
  | {
      ok: true;
      /** Which case fired. 'B' is the only one where the practice has PROVEN it knows the account. */
      case: 'A' | 'B' | 'C';
      /** Stamp on plans.patient_id and applications.patient_id, or null to issue unbound. */
      patientId: string | null;
      /** AES-256-GCM, same format as profiles.sa_id_number. */
      encryptedSaId: string;
      /**
       * Trimmed plaintext, for callers that must write it onward. Never logged.
       *
       * No blind-index hash is returned. findPatientBySaId derives its own to
       * do the lookup, and nothing on the bill side stores one —
       * sa_id_lookup_hash exists on profiles, which is where 0097's unique
       * index lives. Handing one back would imply a bill persists it.
       */
      saIdPlain: string;
      /** Normalised typed address, or null under QR delivery. */
      normalizedEmail: string | null;
    }
  | {
      ok: false;
      error: string;
      /** Present on an identity CONFLICT; absent on a plain validation failure. */
      field?: ConflictField;
    };

/** Copy shared by both surfaces so a field message cannot drift between them. */
export const CAPTURE_MESSAGES = {
  saIdRequired:  'Enter the patient’s 13-digit SA ID number.',
  saIdInvalid:   'Enter a valid 13-digit SA ID number.',
  under18:       'The patient must be 18 or older.',
  emailRequired: 'Enter the patient’s email address.',
  emailInvalid:  'Enter a valid email address, e.g. patient@example.com.',
  lookupFailed:
    'We couldn’t check this ID number just now. Please try again — if it keeps happening, contact support.',
  encryptionFailed: 'Encryption error — please contact support.',
} as const;

export async function captureBillIdentity(
  input: BillIdentityCaptureInput,
): Promise<BillIdentityCapture> {
  const { svc, delivery } = input;

  // ── The ID, validated identically on both surfaces ─────────────────────
  const saIdPlain = (input.saIdNumber ?? '').trim();
  if (!saIdPlain) return { ok: false, error: CAPTURE_MESSAGES.saIdRequired };
  if (!validateSaId(saIdPlain).valid) return { ok: false, error: CAPTURE_MESSAGES.saIdInvalid };

  // The 18+ gate was till-only before this. A dashboard that could issue a
  // bill the till refuses is the same asymmetry this task exists to remove.
  const age = saIdAge(saIdPlain);
  if (age === null || age < 18) return { ok: false, error: CAPTURE_MESSAGES.under18 };

  // ── The address, only when it is the delivery method ───────────────────
  let normalizedEmail: string | null = null;
  if (delivery === 'email') {
    const trimmed = (input.patientEmail ?? '').trim().toLowerCase();
    if (!trimmed) return { ok: false, error: CAPTURE_MESSAGES.emailRequired };
    if (!isValidEmail(trimmed)) return { ok: false, error: CAPTURE_MESSAGES.emailInvalid };
    normalizedEmail = trimmed;
  }

  // ── The two lookups ────────────────────────────────────────────────────
  //
  // A failed lookup is NOT "nobody owns this ID". findPatientBySaId throws
  // on a read error precisely so it cannot be mistaken for null here; the
  // catch turns it into a refusal rather than letting issuance proceed as
  // though the ID were free.
  let idOwner: MatchedAccount | null;
  try {
    idOwner = await findPatientBySaId(svc, saIdPlain);
  } catch (err) {
    console.error('[captureBillIdentity] SA ID lookup failed', err);
    return { ok: false, error: CAPTURE_MESSAGES.lookupFailed };
  }

  let emailOwner: MatchedAccount | null = null;
  if (normalizedEmail) {
    const { data, error } = await svc
      .from('profiles')
      .select('id, email')
      .eq('email', normalizedEmail)
      .eq('role', 'patient')
      .maybeSingle();
    if (error) {
      console.error('[captureBillIdentity] email lookup failed', error.message ?? error);
      return { ok: false, error: CAPTURE_MESSAGES.lookupFailed };
    }
    emailOwner = (data as MatchedAccount | null) ?? null;
  }

  // ── The decision ───────────────────────────────────────────────────────
  const decision = resolveBillIdentity({ idOwner, emailOwner, typedEmail: normalizedEmail, delivery });
  if (!decision.ok) {
    return { ok: false, error: decision.message, field: decision.field };
  }

  // ── Encrypt last, so a refusal costs no crypto and writes nothing ──────
  let encryptedSaId: string;
  try {
    encryptedSaId = encryptId(saIdPlain);
  } catch {
    return { ok: false, error: CAPTURE_MESSAGES.encryptionFailed };
  }

  return {
    ok: true,
    case: decision.case,
    patientId: decision.patientId,
    encryptedSaId,
    saIdPlain,
    normalizedEmail,
  };
}
