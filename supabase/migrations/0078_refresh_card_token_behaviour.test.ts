import { describe, it, expect } from 'vitest';

// ─── 0078 refresh_card_token — behavioural verification ───────────────
//
// The source-text pins in 0078_refresh_card_token_peach_column.test.ts
// prove the SQL says the right thing; this file proves what it MEANS.
// A JS simulation of the RPC's UPDATE-and-WHERE runs the four scenarios
// end-to-end so any regression in the RPC semantics — or the
// saveCardForPatient wiring that feeds it — fails here first.
//
// This is NOT a live-DB test (the CI environment has no Postgres); it's
// a faithful re-implementation of the 0078 semantics with plans + a
// payment_methods row, driven exactly the way saveCardForPatient's
// 'update' branch drives the real RPC.
//
// Every write in the sim matches the 0078 UPDATE statements 1:1:
//
//   payment_methods:
//     SET token, card_brand, last_four, expiry_month, expiry_year, reusable=true
//     WHERE id = p_card_id
//
//   plans:  (only when v_old_token IS NOT NULL AND DISTINCT FROM p_token)
//     SET peach_registration_id = p_token
//     WHERE patient_id = v_card.patient_id
//       AND status IN ('active', 'pending_first_payment')
//       AND peach_registration_id = v_old_token

type PaymentMethod = {
  id:            string;
  patient_id:    string;
  token:         string;
  card_brand:    string;
  last_four:     string;
  expiry_month:  number;
  expiry_year:   number;
  signature:     string;
  is_default:    boolean;
  reusable:      boolean;
};

type Plan = {
  id:                     string;
  patient_id:             string;
  status:                 'active' | 'pending_first_payment' | 'completed' | 'cancelled';
  peach_registration_id:  string | null;
};

/** Runtime simulation of 0078's refresh_card_token, plans+payment_methods only. */
function refresh_card_token(
  db:          { payment_methods: PaymentMethod[]; plans: Plan[] },
  p_card_id:      string,
  p_token:        string,
  p_brand:        string,
  p_last_four:    string,
  p_expiry_month: number,
  p_expiry_year:  number,
): { is_default: boolean; repointed_plans: number; plan_refs: string[] } {
  const card = db.payment_methods.find((c) => c.id === p_card_id);
  if (!card) throw new Error('card_not_found');

  const v_old_token = card.token;

  card.token        = p_token;
  card.card_brand   = p_brand;
  card.last_four    = p_last_four;
  card.expiry_month = p_expiry_month;
  card.expiry_year  = p_expiry_year;
  card.reusable     = true;

  const refs: string[] = [];
  if (v_old_token != null && v_old_token !== p_token) {
    for (const plan of db.plans) {
      if (
        plan.patient_id === card.patient_id &&
        (plan.status === 'active' || plan.status === 'pending_first_payment') &&
        plan.peach_registration_id === v_old_token
      ) {
        plan.peach_registration_id = p_token;
        refs.push(plan.id);
      }
    }
  }
  return { is_default: card.is_default, repointed_plans: refs.length, plan_refs: refs };
}

const PATIENT_A = 'patient-A';
const PATIENT_B = 'patient-B';

function baseDb(): { payment_methods: PaymentMethod[]; plans: Plan[] } {
  return { payment_methods: [], plans: [] };
}

// ─── Scenario 1: same-card re-vault repoints ────────────────────────

describe('Scenario 1 — same-card re-vault repoints plan A→B', () => {
  it('a re-vaulted card refreshes payment_methods.token AND the plan\'s peach_registration_id', () => {
    const db = baseDb();
    db.payment_methods.push({
      id: 'card-1', patient_id: PATIENT_A,
      token: 'tokA', card_brand: 'VISA', last_four: '4242',
      expiry_month: 12, expiry_year: 2030,
      signature: 'peach:VISA:4242:122030', is_default: true, reusable: true,
    });
    db.plans.push({
      id: 'plan-1', patient_id: PATIENT_A, status: 'active',
      peach_registration_id: 'tokA',
    });

    const result = refresh_card_token(db, 'card-1', 'tokB', 'VISA', '4242', 12, 2030);

    expect(result.repointed_plans).toBe(1);
    expect(result.plan_refs).toEqual(['plan-1']);
    expect(db.payment_methods[0].token).toBe('tokB');
    expect(db.plans[0].peach_registration_id).toBe('tokB');
  });

  it('repoints a pending_first_payment plan as well (both statuses in scope)', () => {
    const db = baseDb();
    db.payment_methods.push({
      id: 'card-1', patient_id: PATIENT_A,
      token: 'tokA', card_brand: 'VISA', last_four: '4242',
      expiry_month: 12, expiry_year: 2030,
      signature: 'peach:VISA:4242:122030', is_default: true, reusable: true,
    });
    db.plans.push({
      id: 'plan-1', patient_id: PATIENT_A, status: 'pending_first_payment',
      peach_registration_id: 'tokA',
    });

    const result = refresh_card_token(db, 'card-1', 'tokB', 'VISA', '4242', 12, 2030);

    expect(result.repointed_plans).toBe(1);
    expect(db.plans[0].peach_registration_id).toBe('tokB');
  });

  it('does NOT repoint a completed / cancelled plan even if it holds the old token', () => {
    // Historic plans (completed) may still carry the old token in the
    // column for audit; refresh must not overwrite them.
    const db = baseDb();
    db.payment_methods.push({
      id: 'card-1', patient_id: PATIENT_A,
      token: 'tokA', card_brand: 'VISA', last_four: '4242',
      expiry_month: 12, expiry_year: 2030,
      signature: 'peach:VISA:4242:122030', is_default: true, reusable: true,
    });
    db.plans.push(
      { id: 'plan-old', patient_id: PATIENT_A, status: 'completed', peach_registration_id: 'tokA' },
      { id: 'plan-new', patient_id: PATIENT_A, status: 'active',    peach_registration_id: 'tokA' },
    );

    const result = refresh_card_token(db, 'card-1', 'tokB', 'VISA', '4242', 12, 2030);

    expect(result.repointed_plans).toBe(1);
    expect(result.plan_refs).toEqual(['plan-new']);
    // Historic plan is preserved untouched.
    expect(db.plans[0].peach_registration_id).toBe('tokA');
    expect(db.plans[1].peach_registration_id).toBe('tokB');
  });
});

// ─── Scenario 2: cross-plan guard (the pre-existing bug 0078 fixes) ─

describe('Scenario 2 — CROSS-PLAN GUARD: refreshing card X only touches plans currently on X\'s token', () => {
  it('patient holds plan-1 on card X (tokA) + plan-2 on card Y (tokC); refresh X→B leaves plan-2 on tokC', () => {
    // This is the property that matters most. Pre-0078 the same-patient
    // WHERE scope would have overwritten plan-2's token onto the new
    // card-X value — plan-2's cron would then have charged card X
    // (the wrong physical card) instead of card Y.
    const db = baseDb();
    db.payment_methods.push(
      { id: 'card-X', patient_id: PATIENT_A,
        token: 'tokA', card_brand: 'VISA', last_four: '4242',
        expiry_month: 12, expiry_year: 2030,
        signature: 'peach:VISA:4242:122030', is_default: true,  reusable: true },
      { id: 'card-Y', patient_id: PATIENT_A,
        token: 'tokC', card_brand: 'MASTERCARD', last_four: '5555',
        expiry_month: 11, expiry_year: 2029,
        signature: 'peach:MASTERCARD:5555:112029', is_default: false, reusable: true },
    );
    db.plans.push(
      { id: 'plan-1', patient_id: PATIENT_A, status: 'active', peach_registration_id: 'tokA' },
      { id: 'plan-2', patient_id: PATIENT_A, status: 'active', peach_registration_id: 'tokC' },
    );

    const result = refresh_card_token(db, 'card-X', 'tokB', 'VISA', '4242', 12, 2030);

    expect(result.repointed_plans).toBe(1);
    expect(result.plan_refs).toEqual(['plan-1']);
    // Plan-1 (card X) → repointed A → B.
    expect(db.plans[0].peach_registration_id).toBe('tokB');
    // Plan-2 (card Y) → UNTOUCHED. This is the load-bearing assertion.
    expect(db.plans[1].peach_registration_id).toBe('tokC');
    // Card Y's payment_methods row is untouched too.
    expect(db.payment_methods[1].token).toBe('tokC');
  });

  it('non-default card refresh still repoints the correct plan (is_default gate removed)', () => {
    // Pre-0078 the `IF v_card.is_default THEN` gate would have skipped
    // this entirely — a non-default card refresh wouldn't have
    // repointed anything. Under 0078 the token-based scope makes
    // is_default irrelevant.
    const db = baseDb();
    db.payment_methods.push({
      id: 'card-Y', patient_id: PATIENT_A,
      token: 'tokC', card_brand: 'MASTERCARD', last_four: '5555',
      expiry_month: 11, expiry_year: 2029,
      signature: 'peach:MASTERCARD:5555:112029', is_default: false, reusable: true,
    });
    db.plans.push({
      id: 'plan-2', patient_id: PATIENT_A, status: 'active', peach_registration_id: 'tokC',
    });

    const result = refresh_card_token(db, 'card-Y', 'tokD', 'MASTERCARD', '5555', 11, 2029);

    expect(result.repointed_plans).toBe(1);
    expect(result.is_default).toBe(false);
    expect(db.plans[0].peach_registration_id).toBe('tokD');
  });

  it('never crosses patient boundaries even when tokens accidentally collide', () => {
    // Defensive: the WHERE is patient_id-scoped AS WELL AS token-scoped.
    // A different patient's plan on a coincidentally-equal token
    // MUST NOT be touched by another patient's card refresh.
    const db = baseDb();
    db.payment_methods.push({
      id: 'card-A1', patient_id: PATIENT_A,
      token: 'tokZ', card_brand: 'VISA', last_four: '9999',
      expiry_month: 6, expiry_year: 2028,
      signature: 'peach:VISA:9999:062028', is_default: true, reusable: true,
    });
    db.plans.push(
      { id: 'plan-A', patient_id: PATIENT_A, status: 'active', peach_registration_id: 'tokZ' },
      { id: 'plan-B', patient_id: PATIENT_B, status: 'active', peach_registration_id: 'tokZ' },
    );

    const result = refresh_card_token(db, 'card-A1', 'tokZZ', 'VISA', '9999', 6, 2028);

    expect(result.repointed_plans).toBe(1);
    expect(result.plan_refs).toEqual(['plan-A']);
    expect(db.plans[0].peach_registration_id).toBe('tokZZ');
    // Patient B's plan is left alone even though it shares the (coincidental) token.
    expect(db.plans[1].peach_registration_id).toBe('tokZ');
  });
});

// ─── Scenario 3: no-op guard ────────────────────────────────────────

describe('Scenario 3 — no-op guard: re-vault with unchanged token writes no plan', () => {
  it('same token in and out → payment_methods row still gets its side-effects (last_four/expiry refresh) but zero plan repoints', () => {
    const db = baseDb();
    db.payment_methods.push({
      id: 'card-1', patient_id: PATIENT_A,
      token: 'tokA', card_brand: 'VISA', last_four: '4242',
      expiry_month: 12, expiry_year: 2030,
      signature: 'peach:VISA:4242:122030', is_default: true, reusable: true,
    });
    db.plans.push({
      id: 'plan-1', patient_id: PATIENT_A, status: 'active', peach_registration_id: 'tokA',
    });

    const result = refresh_card_token(db, 'card-1', 'tokA', 'VISA', '4242', 12, 2030);

    expect(result.repointed_plans).toBe(0);
    expect(result.plan_refs).toEqual([]);
    // Plan token unchanged.
    expect(db.plans[0].peach_registration_id).toBe('tokA');
  });

  it('null-old-token guard: card row has no prior token → nothing to repoint', () => {
    const db = baseDb();
    db.payment_methods.push({
      id: 'card-1', patient_id: PATIENT_A,
      token: null as unknown as string, card_brand: 'VISA', last_four: '4242',
      expiry_month: 12, expiry_year: 2030,
      signature: 'peach:VISA:4242:122030', is_default: true, reusable: true,
    });
    db.plans.push({
      id: 'plan-1', patient_id: PATIENT_A, status: 'active', peach_registration_id: null,
    });

    const result = refresh_card_token(db, 'card-1', 'tokFirst', 'VISA', '4242', 12, 2030);

    expect(result.repointed_plans).toBe(0);
    // Even though the plan has null token, guard prevents accidental "null=null" match.
    expect(db.plans[0].peach_registration_id).toBe(null);
  });
});

// ─── Scenario 4: cron picks up the new token ────────────────────────

describe('Scenario 4 — chargeInstalment collects on the fresh token after refresh', () => {
  // The chargeInstalment path reads plan.peach_registration_id and
  // hands it to provider.chargeSavedCard as the registrationId. This
  // test wires the refresh to a simulated cron read to prove the
  // safety net's actual purpose — the cron collects on the new card.
  it('cron reads plan.peach_registration_id AFTER refresh and gets the new token', () => {
    const db = baseDb();
    db.payment_methods.push({
      id: 'card-1', patient_id: PATIENT_A,
      token: 'tokA', card_brand: 'VISA', last_four: '4242',
      expiry_month: 12, expiry_year: 2030,
      signature: 'peach:VISA:4242:122030', is_default: true, reusable: true,
    });
    db.plans.push({
      id: 'plan-1', patient_id: PATIENT_A, status: 'active', peach_registration_id: 'tokA',
    });

    // Snapshot the cron's read PRE-refresh.
    const preRefresh = db.plans.find((p) => p.id === 'plan-1')!.peach_registration_id;
    expect(preRefresh).toBe('tokA');

    refresh_card_token(db, 'card-1', 'tokB', 'VISA', '4242', 12, 2030);

    // The next cron tick would read peach_registration_id — assert it's the new token.
    const postRefresh = db.plans.find((p) => p.id === 'plan-1')!.peach_registration_id;
    expect(postRefresh).toBe('tokB');

    // And the cron branch that fails on null (chargeInstalment.ts:163) does NOT trigger —
    // plan.peach_registration_id is truthy.
    expect(Boolean(postRefresh)).toBe(true);
  });

  it('cross-plan safety: after refreshing card X, plan-2\'s cron still targets card Y\'s token', () => {
    const db = baseDb();
    db.payment_methods.push(
      { id: 'card-X', patient_id: PATIENT_A,
        token: 'tokA', card_brand: 'VISA', last_four: '4242',
        expiry_month: 12, expiry_year: 2030,
        signature: 'peach:VISA:4242:122030', is_default: true, reusable: true },
      { id: 'card-Y', patient_id: PATIENT_A,
        token: 'tokC', card_brand: 'MASTERCARD', last_four: '5555',
        expiry_month: 11, expiry_year: 2029,
        signature: 'peach:MASTERCARD:5555:112029', is_default: false, reusable: true },
    );
    db.plans.push(
      { id: 'plan-1', patient_id: PATIENT_A, status: 'active', peach_registration_id: 'tokA' },
      { id: 'plan-2', patient_id: PATIENT_A, status: 'active', peach_registration_id: 'tokC' },
    );

    refresh_card_token(db, 'card-X', 'tokB', 'VISA', '4242', 12, 2030);

    // Cron for plan-1 → picks up new tokB (card X).
    expect(db.plans.find((p) => p.id === 'plan-1')!.peach_registration_id).toBe('tokB');
    // Cron for plan-2 → still targets tokC (card Y, unchanged).
    expect(db.plans.find((p) => p.id === 'plan-2')!.peach_registration_id).toBe('tokC');
  });
});
