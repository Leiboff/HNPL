// ─── The correlation facts a money decision needs ───────────────────────
//
// `evaluateRisk` takes signals; this is where the ones that live in the
// database are read. It exists so the two surfaces where credit is committed
// and money moves — `acceptPlan` and `payWithSavedCard` — ask the same
// questions in the same way, rather than each growing its own slightly
// different set of joins and drifting apart.
//
// Four facts, and each is one link in the audit's chain:
//
//   identityHash    the SA ID blind index. The duplicate-identity edge.
//   cardFingerprint the payment instrument. The hardest thing for a ring to
//                   rotate genuinely, and therefore the strongest link.
//   bankAccount     where the merchant's money is going. Two "different"
//                   practices settling into one account is the shell-branch
//                   pattern, and this is the only place it is visible.
//   practiceGroupId the brand. A ring that registers five branches under one
//                   brand is one merchant, not five.
//
// ─── FAILURE IS SILENT AND THAT IS CORRECT ──────────────────────────────
//
// Every read here degrades to null. A fact that cannot be read makes its
// rule skip — the decision is taken on the facts that WERE available rather
// than refused for want of one. Refusing instead would mean a slow read
// replica turns into a declined plan for a customer standing at a counter,
// and the aggregate controls would become the least reliable part of the
// checkout.
//
// The gap is not invisible: `collectRiskSignals` reports every requested
// dimension it could not resolve, and evaluateRisk carries that into the
// telemetry line.

import { resolvePayoutBanking } from '@/lib/practice/banking';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

export type PlanRiskFacts = {
  identityHash: string | null;
  phone: string | null;
  email: string | null;
  cardFingerprint: string | null;
  bankAccount: string | null;
  practiceGroupId: string | null;
};

export const EMPTY_PLAN_RISK_FACTS: PlanRiskFacts = {
  identityHash: null,
  phone: null,
  email: null,
  cardFingerprint: null,
  bankAccount: null,
  practiceGroupId: null,
};

async function readPatient(db: Svc, patientId: string) {
  try {
    const { data } = await db
      .from('profiles')
      .select('sa_id_lookup_hash, phone, email')
      .eq('id', patientId)
      .maybeSingle();
    return data ?? null;
  } catch {
    return null;
  }
}

/**
 * The instrument this plan will be charged against.
 *
 * `signature` is the synthetic fingerprint from
 * lib/payments/peach/saveCardForPatient.ts — brand, last four and expiry,
 * stable per physical card until the issuer reissues. Peach exposes no
 * canonical fingerprint, so this is the best available identity for an
 * instrument, and it is re-tokenised before it reaches the store.
 *
 * Archived cards are excluded: a removed card is not the instrument this
 * plan will use, and counting it would link a customer to an account they
 * stopped sharing a card with months ago.
 *
 * When a specific method is named (the saved-card path knows exactly which
 * card it is about to charge) that one is read; otherwise the default.
 */
async function readCardFingerprint(
  db: Svc,
  patientId: string,
  paymentMethodId?: string | null,
): Promise<string | null> {
  try {
    let query = db
      .from('payment_methods')
      .select('signature')
      .eq('patient_id', patientId)
      .is('archived_at', null);

    query = paymentMethodId
      ? query.eq('id', paymentMethodId)
      : query.eq('is_default', true);

    const { data } = await query.limit(1).maybeSingle();
    return (data?.signature as string | null) ?? null;
  } catch {
    return null;
  }
}

async function readMerchant(db: Svc, practiceId: string) {
  try {
    const [{ data: practice }, banking] = await Promise.all([
      db.from('practices').select('group_id').eq('id', practiceId).maybeSingle(),
      // The canonical resolver, deliberately: "which account does this
      // practice settle into" must have exactly one answer, and a second
      // implementation here would be the one that goes stale when the
      // brand-fallback rule changes.
      resolvePayoutBanking(db, practiceId),
    ]);
    return {
      groupId: (practice?.group_id as string | null) ?? null,
      bankAccount:
        banking.source === 'none'
          ? null
          : banking.banking.bank_account_number ?? null,
    };
  } catch {
    return { groupId: null, bankAccount: null };
  }
}

export async function loadPlanRiskFacts(
  db: Svc,
  input: { patientId: string; practiceId?: string | null; paymentMethodId?: string | null },
): Promise<PlanRiskFacts> {
  const [patient, cardFingerprint, merchant] = await Promise.all([
    readPatient(db, input.patientId),
    readCardFingerprint(db, input.patientId, input.paymentMethodId),
    input.practiceId
      ? readMerchant(db, input.practiceId)
      : Promise.resolve({ groupId: null, bankAccount: null }),
  ]);

  return {
    identityHash:    (patient?.sa_id_lookup_hash as string | null) ?? null,
    phone:           (patient?.phone as string | null) ?? null,
    email:           (patient?.email as string | null) ?? null,
    cardFingerprint,
    bankAccount:     merchant.bankAccount,
    practiceGroupId: merchant.groupId,
  };
}
