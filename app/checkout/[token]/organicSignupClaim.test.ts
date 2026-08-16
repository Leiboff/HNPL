import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { VALID_SA_IDS } from '@/lib/testing/saIdFixtures';

// ─── The dead end that migration 0098 retires ────────────────────────────
//
// A practice emails a bill to an address with no BetterNow account. Before
// the patient clicks the link, they sign up independently — a different
// address, their own way in. Then they open the emailed link while signed
// in.
//
// What used to happen: plans.patient_id was NULL (nobody to bind at
// issuance) and the claim was gated on `resolved.kind === 'session'`, so it
// never ran for an invitation. The page compared NULL to their user id,
// failed, and showed a card telling them to ask reception — about a bill
// that was provably theirs, with their own ID on it.
//
// What happens now: the invitation carries the practice-typed ID, the claim
// runs for any unbound plan whose token carries one, their profile ID
// matches, and the plan binds. No card at all.
//
// This drives claimUnboundSessionPlan directly, because the claim IS the
// mechanism — the page change is just widening who reaches it, and that
// widening is pinned in invitationIdMatch.test.ts.

const BILL_SA_ID  = VALID_SA_IDS[0];
const OTHER_SA_ID = VALID_SA_IDS[1];

let encryptId: (s: string) => string;
let claimUnboundSessionPlan: typeof import('@/lib/checkout/claimSessionPlan')['claimUnboundSessionPlan'];

beforeAll(async () => {
  process.env.SA_ID_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  ({ encryptId } = await import('@/lib/idEncryption'));
  ({ claimUnboundSessionPlan } = await import('@/lib/checkout/claimSessionPlan'));
});

// ── A database just real enough for the claim's two writes ──────────────

type Profile = { id: string; sa_id_number: string | null };
type Plan    = { id: string; patient_id: string | null };

let profiles: Profile[] = [];
let plans:    Plan[]    = [];

function svcStub() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let isNullCol: string | null = null;
      let patch: Record<string, unknown> | null = null;

      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (p: Record<string, unknown>) => { patch = p; return chain; },
        eq: (c: string, v: unknown) => { filters[c] = v; return chain; },
        is: (c: string, _v: null) => { isNullCol = c; return chain; },
        maybeSingle: async () => {
          if (table === 'profiles') {
            return { data: profiles.find((p) => p.id === filters.id) ?? null, error: null };
          }
          return { data: plans.find((p) => p.id === filters.id) ?? null, error: null };
        },
        // The claim's guarded write: .update(...).eq('id', …).is('patient_id', null).select('id')
        then: (resolve: (v: unknown) => void) => {
          const rows = plans.filter(
            (p) => p.id === filters.id && (isNullCol !== 'patient_id' || p.patient_id === null),
          );
          for (const r of rows) Object.assign(r, patch);
          resolve({ data: rows.map((r) => ({ id: r.id })), error: null });
        },
      };
      return chain;
    },
  };
}

beforeEach(() => {
  profiles = [];
  plans = [];
});

function world(opts: { profileSaId: string | null; planOwner?: string | null }) {
  const userId = randomUUID();
  const planId = randomUUID();
  profiles.push({
    id: userId,
    sa_id_number: opts.profileSaId ? encryptId(opts.profileSaId) : null,
  });
  plans.push({ id: planId, patient_id: opts.planOwner ?? null });
  return { userId, planId };
}

describe('organic signup, then the emailed link', () => {
  it('binds automatically when their own ID is the one on the bill', async () => {
    const { userId, planId } = world({ profileSaId: BILL_SA_ID });

    const claim = await claimUnboundSessionPlan({
      svc: svcStub(),
      planId,
      applicationId: null,
      userId,
      sessionSaIdEncrypted: encryptId(BILL_SA_ID),   // the invitation's stored ID
    });

    expect(claim).toEqual({ claimed: true, reason: 'claimed' });
    // The bill is now theirs — no card, no reception, no dead end.
    expect(plans.find((p) => p.id === planId)?.patient_id).toBe(userId);
  });

  it('works even though the two ciphertexts differ — the compare is on plaintext', async () => {
    // The invitation's ID and the profile's ID are separate encryptions of
    // the same number, so a naive string compare would refuse a legitimate
    // patient every single time.
    const { userId, planId } = world({ profileSaId: BILL_SA_ID });
    const a = encryptId(BILL_SA_ID);
    const b = encryptId(BILL_SA_ID);
    expect(a).not.toBe(b);

    const claim = await claimUnboundSessionPlan({
      svc: svcStub(), planId, applicationId: null, userId, sessionSaIdEncrypted: a,
    });
    expect(claim.claimed).toBe(true);
  });
});

describe('and it still refuses everyone it should', () => {
  it('a different ID does not bind, and the plan is untouched', async () => {
    const { userId, planId } = world({ profileSaId: OTHER_SA_ID });

    const claim = await claimUnboundSessionPlan({
      svc: svcStub(), planId, applicationId: null, userId,
      sessionSaIdEncrypted: encryptId(BILL_SA_ID),
    });

    expect(claim).toEqual({ claimed: false, reason: 'id_mismatch' });
    expect(plans.find((p) => p.id === planId)?.patient_id).toBeNull();
  });

  it('an account with no ID cannot claim anything', async () => {
    const { userId, planId } = world({ profileSaId: null });

    const claim = await claimUnboundSessionPlan({
      svc: svcStub(), planId, applicationId: null, userId,
      sessionSaIdEncrypted: encryptId(BILL_SA_ID),
    });

    expect(claim).toEqual({ claimed: false, reason: 'no_profile_id' });
    expect(plans.find((p) => p.id === planId)?.patient_id).toBeNull();
  });

  it('an unreadable stored ID fails CLOSED', async () => {
    const { userId, planId } = world({ profileSaId: BILL_SA_ID });

    const claim = await claimUnboundSessionPlan({
      svc: svcStub(), planId, applicationId: null, userId,
      sessionSaIdEncrypted: 'v1:not:valid:ciphertext',
    });

    expect(claim).toEqual({ claimed: false, reason: 'decrypt_failed' });
    expect(plans.find((p) => p.id === planId)?.patient_id).toBeNull();
  });

  it('a plan that already has an owner is immovable, even on a matching ID', async () => {
    const stranger = randomUUID();
    const { userId, planId } = world({ profileSaId: BILL_SA_ID, planOwner: stranger });

    const claim = await claimUnboundSessionPlan({
      svc: svcStub(), planId, applicationId: null, userId,
      sessionSaIdEncrypted: encryptId(BILL_SA_ID),
    });

    expect(claim).toEqual({ claimed: false, reason: 'already_bound' });
    expect(plans.find((p) => p.id === planId)?.patient_id).toBe(stranger);
  });
});

describe('what widening the claim did NOT widen', () => {
  it('the claim helper still takes an encrypted ID and nothing weaker', async () => {
    // Widening WHO may call it must not widen WHAT it accepts. Passing the
    // plaintext where ciphertext belongs must fail, not accidentally work.
    const { userId, planId } = world({ profileSaId: BILL_SA_ID });

    const claim = await claimUnboundSessionPlan({
      svc: svcStub(), planId, applicationId: null, userId,
      sessionSaIdEncrypted: BILL_SA_ID,   // plaintext — wrong
    });

    expect(claim.claimed).toBe(false);
    expect(plans.find((p) => p.id === planId)?.patient_id).toBeNull();
  });
});
