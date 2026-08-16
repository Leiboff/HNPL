import { describe, it, expect } from 'vitest';
import {
  resolveBillIdentity,
  BILL_IDENTITY_MESSAGES,
  type BillIdentityInput,
  type DeliveryMethod,
} from './billIdentity';

// The five-case table, exhaustively. This is the whole decision — the
// server actions do lookups and writes, but nothing else decides WHO a bill
// belongs to, so a gap here is a gap everywhere.

const X = { id: 'acct-X', email: 'x@example.com' };
const Y = { id: 'acct-Y', email: 'y@example.com' };

const resolve = (over: Partial<BillIdentityInput> = {}) =>
  resolveBillIdentity({
    idOwner:    null,
    emailOwner: null,
    typedEmail: null,
    delivery:   'qr',
    ...over,
  });

describe('case A — neither lookup resolves', () => {
  it.each<DeliveryMethod>(['qr', 'email'])('%s: issues UNBOUND', (delivery) => {
    const r = resolve({ delivery, typedEmail: delivery === 'email' ? 'new@example.com' : null });
    expect(r).toEqual({ ok: true, case: 'A', patientId: null });
  });
});

describe('case B — both resolve to the same account', () => {
  it.each<DeliveryMethod>(['qr', 'email'])('%s: binds at issuance', (delivery) => {
    const r = resolve({ idOwner: X, emailOwner: X, typedEmail: X.email, delivery });
    expect(r).toEqual({ ok: true, case: 'B', patientId: X.id });
  });
});

describe('case C — the ID resolves, the email does not', () => {
  it('QR: binds to the ID\'s account and proceeds — no address is involved', () => {
    const r = resolve({ idOwner: X, delivery: 'qr' });
    expect(r).toEqual({ ok: true, case: 'C', patientId: X.id });
  });

  it('EMAIL to an address that is NOT the account\'s: REFUSED', () => {
    // The disclosure case. Binding to X and mailing to somebody else's
    // address hands a stranger a payment link for X's bill.
    const r = resolve({ idOwner: X, typedEmail: 'someone.else@example.com', delivery: 'email' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.case).toBe('C');
    expect(r.field).toBe('email');
    expect(r.message).toBe(BILL_IDENTITY_MESSAGES.emailNotTheIdsOwn);
  });

  it('EMAIL to the account\'s OWN address: proceeds', () => {
    // Reachable when the email lookup misses a row the ID lookup found —
    // a differently-cased stored address, a changed role, an unconfirmed
    // profile. The rule is enforced by comparing the addresses, not by
    // trusting the two lookups to stay in step.
    const r = resolve({ idOwner: X, typedEmail: X.email, delivery: 'email' });
    expect(r).toEqual({ ok: true, case: 'C', patientId: X.id });
  });

  it('EMAIL comparison ignores case and surrounding whitespace', () => {
    const r = resolve({ idOwner: X, typedEmail: '  X@Example.COM ', delivery: 'email' });
    expect(r).toEqual({ ok: true, case: 'C', patientId: X.id });
  });

  it('EMAIL refuses when the matched account has NO address to compare against', () => {
    // A null stored email can never equal a typed one. Fails closed rather
    // than treating "nothing to compare" as agreement.
    const r = resolve({ idOwner: { id: 'acct-Z', email: null }, typedEmail: 'z@example.com', delivery: 'email' });
    expect(r.ok).toBe(false);
  });
});

describe('case D — the email resolves, the ID does not', () => {
  it.each<DeliveryMethod>(['qr', 'email'])('%s: REFUSED, pointing at the ID field', (delivery) => {
    const r = resolve({ emailOwner: Y, typedEmail: Y.email, delivery });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.case).toBe('D');
    expect(r.field).toBe('sa_id');
    expect(r.message).toBe(BILL_IDENTITY_MESSAGES.idDoesNotMatchEmailAccount);
  });
});

describe('case E — both resolve, to DIFFERENT accounts', () => {
  it.each<DeliveryMethod>(['qr', 'email'])('%s: REFUSED, pointing at both fields', (delivery) => {
    const r = resolve({ idOwner: X, emailOwner: Y, typedEmail: Y.email, delivery });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.case).toBe('E');
    expect(r.field).toBe('both');
  });

  it('is decided BEFORE C and D, so it cannot be reached by falling through them', () => {
    // If E were checked after C, an ID+email pair belonging to two people
    // would resolve as "C, bind to X" whenever the email lookup happened
    // to miss — silently billing the wrong person.
    const r = resolve({ idOwner: X, emailOwner: Y, typedEmail: X.email, delivery: 'email' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.case).toBe('E');
  });
});

describe('the ID is the key — a typo can never silently bill someone else', () => {
  it('no refusal names the other account\'s email, name or id', () => {
    // The adversarial case: every refusal message, checked against every
    // identifier we hold at decision time.
    const refusals = [
      resolve({ idOwner: X, typedEmail: 'someone.else@example.com', delivery: 'email' }),
      resolve({ emailOwner: Y, typedEmail: Y.email, delivery: 'email' }),
      resolve({ idOwner: X, emailOwner: Y, typedEmail: Y.email, delivery: 'email' }),
      resolve({ emailOwner: Y, typedEmail: Y.email, delivery: 'qr' }),
    ];
    expect(refusals.every((r) => !r.ok)).toBe(true);

    for (const r of refusals) {
      if (r.ok) continue;
      for (const secret of [X.id, X.email, Y.id, Y.email, 'acct-']) {
        expect(r.message).not.toContain(secret);
      }
    }
  });

  it('every refusal names a field, so the practice knows what to re-read', () => {
    const refusals = [
      resolve({ idOwner: X, typedEmail: 'other@example.com', delivery: 'email' }),
      resolve({ emailOwner: Y, typedEmail: Y.email, delivery: 'email' }),
      resolve({ idOwner: X, emailOwner: Y, typedEmail: Y.email, delivery: 'email' }),
    ];
    for (const r of refusals) {
      if (r.ok) throw new Error('expected a refusal');
      expect(['sa_id', 'email', 'both']).toContain(r.field);
      expect(r.message.length).toBeGreaterThan(20);
    }
  });

  it('a mistyped ID that hits a REAL other account never binds under email delivery', () => {
    // Reception means to bill the patient at the counter, fat-fingers the
    // ID, and it lands on a real stranger's account. Under email delivery
    // the outcome must be a refusal, never a bound bill.
    const stranger = { id: 'acct-stranger', email: 'stranger@example.com' };

    const noEmailAccount = resolve({ idOwner: stranger, typedEmail: 'patient@example.com', delivery: 'email' });
    expect(noEmailAccount.ok).toBe(false);

    const emailIsSomeoneElse = resolve({
      idOwner: stranger, emailOwner: Y, typedEmail: Y.email, delivery: 'email',
    });
    expect(emailIsSomeoneElse.ok).toBe(false);
  });
});

describe('the resolution is total', () => {
  it('every combination of the three inputs produces a decision', () => {
    // 3 idOwner × 3 emailOwner × 2 typedEmail × 2 delivery. No input
    // reaches the end of the function undecided, and an `ok: true` always
    // carries a patientId field (null included) while a refusal never does.
    const owners = [null, X, Y];
    let seen = 0;
    for (const idOwner of owners) {
      for (const emailOwner of owners) {
        for (const typedEmail of [null, X.email]) {
          for (const delivery of ['qr', 'email'] as DeliveryMethod[]) {
            const r = resolveBillIdentity({ idOwner, emailOwner, typedEmail, delivery });
            expect(typeof r.ok).toBe('boolean');
            if (r.ok) expect(r).toHaveProperty('patientId');
            else expect(r).toHaveProperty('field');
            seen += 1;
          }
        }
      }
    }
    expect(seen).toBe(3 * 3 * 2 * 2);
  });

  it('never returns a bound patientId on a refusal', () => {
    const owners = [null, X, Y];
    for (const idOwner of owners) {
      for (const emailOwner of owners) {
        for (const delivery of ['qr', 'email'] as DeliveryMethod[]) {
          const r = resolveBillIdentity({ idOwner, emailOwner, typedEmail: X.email, delivery });
          if (!r.ok) expect(r).not.toHaveProperty('patientId');
        }
      }
    }
  });
});
